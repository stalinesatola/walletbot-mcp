// Tick do grid: preço → ações do grid → travas de risco → execução (paper ou live).
import { riskLimits, type Env } from "./env";
import { McpClient } from "./mcp";
import { getAccessToken } from "./oauth";
import { PaperExecutor, type Executor } from "./paper";
import { publicMid } from "./prices";
import { checkOpen, dailyLossExceeded } from "./risk";
import { gridExposure, loadMap, loadState, saveState, type BotState } from "./state";
import { computeActions } from "./strategy/grid";
import { Walt } from "./walt";

class LiveExecutor implements Executor {
  constructor(
    private walt: Walt,
    private market: string,
  ) {}
  equity() {
    return this.walt.equity(this.market);
  }
  buy(sizeUsd: number, leverage: number, price: number) {
    return this.walt.openLong(this.market, sizeUsd, leverage, price);
  }
  sell(qty: number, price: number) {
    return this.walt.reduce(this.market, qty, price);
  }
}

export async function connectWalt(env: Env): Promise<Walt | null> {
  const token = await getAccessToken(env);
  if (!token) return null;
  return new Walt(new McpClient(env.WALT_MCP_URL, token), await loadMap(env));
}

export async function currentPrice(env: Env, market: string, walt: Walt | null): Promise<number> {
  return walt?.has("price") ? walt.price(market) : publicMid(market);
}

/** Executa um tick e devolve as mensagens a enviar ao dono. */
export async function tick(env: Env): Promise<string[]> {
  const state = await loadState(env);
  if (!state.running || !state.grid || state.paused) return [];
  const msgs: string[] = [];
  try {
    await runTick(env, state, msgs);
    state.lastError = undefined;
  } catch (e) {
    const err = (e as Error).message;
    if (err !== state.lastError) msgs.push(`⚠️ Erro no tick: ${err}`);
    state.lastError = err;
  }
  state.lastTick = new Date().toISOString();
  await saveState(env, state);
  return msgs;
}

async function runTick(env: Env, state: BotState, msgs: string[]): Promise<void> {
  const grid = state.grid!;
  const { cfg, levels } = grid;
  const limits = riskLimits(env);
  const walt = await connectWalt(env);

  let executor: Executor;
  let paper: PaperExecutor | undefined;
  if (state.mode === "live") {
    const map = await loadMap(env);
    if (!walt || !map.confirmed || !walt.has("open") || !walt.has("close") || !walt.has("account")) {
      state.paused = "modo live sem conexão Walt ou sem mapeamento confirmado (/connect, /tools, /map confirm)";
      msgs.push(`⏸️ Pausado: ${state.paused}`);
      return;
    }
    executor = new LiveExecutor(walt, cfg.market);
  } else {
    executor = paper = new PaperExecutor(state);
  }

  const price = await currentPrice(env, cfg.market, walt);
  state.lastPrice = price;
  const equity = await executor.equity(price);

  const today = new Date().toISOString().slice(0, 10);
  if (state.day?.date !== today) state.day = { date: today, startEquity: equity };
  const ctx = () => ({
    equityUsd: equity,
    openMarginUsd: gridExposure(levels, price, cfg.leverage).margin,
    dayStartEquityUsd: state.day!.startEquity,
  });

  if (dailyLossExceeded(ctx(), limits)) {
    state.paused = `perda diária >= ${limits.maxDailyLossPct}% (patrimônio $${equity.toFixed(2)} vs $${state.day.startEquity.toFixed(2)} no início do dia). Use /resume`;
    msgs.push(`🛑 Pausado: ${state.paused}`);
    return;
  }

  for (const action of computeActions(cfg, levels, price, limits.stopLossPct)) {
    if (action.type === "stopLoss") {
      let pnl = 0;
      for (const l of levels) pnl += await closeLevel(executor, paper, state, l, price);
      state.running = false;
      msgs.push(`🛑 Stop-loss ${cfg.market} a $${price}: posições fechadas, PnL $${pnl.toFixed(2)}. Grid parado.`);
      return;
    }
    if (action.type === "sell") {
      const l = levels[action.level];
      const pnl = await closeLevel(executor, paper, state, l, price);
      msgs.push(`🟢 Venda nível ${action.level + 1} ${cfg.market} a $${price} (PnL $${pnl.toFixed(2)})`);
      continue;
    }
    const decision = checkOpen(cfg.market, action.sizeUsd, cfg.leverage, ctx(), limits);
    if (!decision.ok) {
      const err = `compra bloqueada pelo risco: ${decision.reason}`;
      if (err !== state.lastBlock) msgs.push(`🚫 ${err}`);
      state.lastBlock = err;
      continue;
    }
    state.lastBlock = undefined;
    const fill = await executor.buy(decision.sizeUsd, decision.leverage, price);
    levels[action.level].qty = fill.qty;
    levels[action.level].entryPrice = fill.price;
    state.stats.buys++;
    msgs.push(`🔵 Compra nível ${action.level + 1} ${cfg.market}: $${decision.sizeUsd.toFixed(2)} a $${fill.price} (${decision.leverage}x)`);
  }
}

async function closeLevel(
  executor: Executor,
  paper: PaperExecutor | undefined,
  state: BotState,
  level: { qty?: number; entryPrice?: number },
  price: number,
): Promise<number> {
  if (!level.qty || !level.entryPrice) return 0;
  const fill = await executor.sell(level.qty, price);
  const pnl = paper ? paper.settle(level.qty, level.entryPrice, fill.price) : level.qty * (fill.price - level.entryPrice);
  state.stats.sells++;
  state.stats.realizedPnl += pnl;
  level.qty = undefined;
  level.entryPrice = undefined;
  return pnl;
}

/** Fecha todas as posições do grid (comando /closeall). */
export async function closeAll(env: Env): Promise<string> {
  const state = await loadState(env);
  if (!state.grid) return "Nenhum grid configurado.";
  const walt = await connectWalt(env);
  const price = await currentPrice(env, state.grid.cfg.market, walt);
  let executor: Executor;
  let paper: PaperExecutor | undefined;
  if (state.mode === "live") {
    if (!walt) return "Walt não conectado — feche as posições pelo app Walt.";
    executor = new LiveExecutor(walt, state.grid.cfg.market);
  } else executor = paper = new PaperExecutor(state);
  let pnl = 0;
  for (const l of state.grid.levels) pnl += await closeLevel(executor, paper, state, l, price);
  state.running = false;
  await saveState(env, state);
  return `Posições fechadas a $${price}. PnL $${pnl.toFixed(2)}. Grid parado.`;
}
