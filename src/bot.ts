// Tick: preço → posição atual → (fechou por TP/SL?) → entrada no degrau → travas de risco → ordem.
import { riskLimits, type Env } from "./env";
import { McpClient } from "./mcp";
import { getAccessToken } from "./oauth";
import { publicMid } from "./prices";
import { pushEquity, pushPrice, recordTrade } from "./history";
import { checkOpen, dailyLossExceeded } from "./risk";
import { loadState, saveState, type BotState } from "./state";
import { exitHit, planEntry, type GridConfig, type GridPosition } from "./strategy/grid";
import { Walt } from "./walt";

export async function connectWalt(env: Env): Promise<Walt | null> {
  const token = await getAccessToken(env);
  return token ? new Walt(new McpClient(env.WALT_MCP_URL, token)) : null;
}

export async function currentPrice(cfg: GridConfig, walt: Walt | null): Promise<number> {
  return walt ? walt.rate(cfg.contract) : publicMid(cfg.market);
}

/** PnL de uma posição do grid saindo a `exit` (inclui taxa taker na saída; a da entrada já saiu da margem). */
export function positionPnl(pos: GridPosition, exit: number, takerFeePct: number): number {
  return pos.qty * (exit - pos.entryPrice) - pos.qty * exit * takerFeePct;
}

export function paperEquity(state: BotState, price: number): number {
  const pos = state.grid?.position;
  const fee = state.grid?.cfg.contract.takerFeePct ?? 0;
  return state.paper.cash + (pos ? positionPnl(pos, price, fee) : 0);
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

async function recordClose(
  env: Env,
  state: BotState,
  pos: GridPosition,
  exit: number,
  pnl: number,
  reason: "tp" | "sl" | "manual",
): Promise<void> {
  state.stats.trades++;
  state.stats.realizedPnl += pnl;
  if (pnl >= 0) state.stats.wins++;
  else state.stats.losses++;
  const cfg = state.grid!.cfg;
  await recordTrade(env, {
    at: new Date().toISOString(),
    market: cfg.market,
    event: "close",
    price: exit,
    marginUsd: pos.marginUsd,
    leverage: cfg.leverage,
    pnl,
    reason,
    mode: state.mode,
  });
  if (state.mode === "paper") pushEquity(state, state.paper.cash, true);
}

async function runTick(env: Env, state: BotState, msgs: string[]): Promise<void> {
  const grid = state.grid!;
  const { cfg } = grid;
  const limits = riskLimits(env);
  const walt = await connectWalt(env);
  const live = state.mode === "live";
  if (live && !walt) {
    state.paused = "modo live sem conexão com o Walt (/connect)";
    msgs.push(`⏸️ Pausado: ${state.paused}`);
    return;
  }

  const price = await currentPrice(cfg, walt);
  state.lastPrice = price;
  pushPrice(state, cfg.market, price);
  if (live) {
    // saldo para a curva de patrimônio: no máximo uma consulta por hora
    const last = state.equity?.[state.equity.length - 1];
    if (!last || Date.now() - last[0] >= 3_600_000) pushEquity(state, await walt!.balanceUsd().catch(() => last?.[1] ?? 0));
  } else {
    pushEquity(state, paperEquity(state, price));
  }

  // 1) a posição do grid ainda está aberta?
  if (grid.position) {
    const pos = grid.position;
    let closedBy: "tp" | "sl" | null = null;
    if (live) {
      // a abertura é assíncrona no Walt: espera 2 min antes de concluir que a posição sumiu
      const recent = Date.now() - Date.parse(pos.openedAt) < 120_000;
      if (!recent && !(await walt!.openPosition(cfg.contract.contractId)))
        closedBy = price >= (pos.takeProfit + pos.stopLoss) / 2 ? "tp" : "sl";
    } else {
      closedBy = exitHit(pos, price);
    }
    if (!closedBy) return; // posição aberta: TP/SL cuidam da saída
    const exit = closedBy === "tp" ? pos.takeProfit : pos.stopLoss;
    const pnl = positionPnl(pos, exit, cfg.contract.takerFeePct);
    if (!live) state.paper.cash += pnl;
    await recordClose(env, state, pos, exit, pnl, closedBy);
    grid.position = undefined;
    if (closedBy === "tp") {
      msgs.push(`🟢 Take-profit ${cfg.market} nível ${pos.level + 1}: saída ~$${exit} (PnL ~$${pnl.toFixed(2)})`);
    } else {
      state.running = false;
      msgs.push(`🛑 Stop-loss ${cfg.market}: saída ~$${exit} (PnL ~$${pnl.toFixed(2)}). Grid parado — /run para reiniciar.`);
      return;
    }
  } else if (live && (await walt!.openPosition(cfg.contract.contractId))) {
    const block = `já existe uma posição ${cfg.market} na conta que não foi aberta pelo grid — feche-a ou use /closeall`;
    if (block !== state.lastBlock) msgs.push(`🚫 ${block}`);
    state.lastBlock = block;
    return;
  }

  // 2) entrada no degrau
  const plan = planEntry(cfg, price, limits.stopLossPct);
  if (!plan) return;

  const equity = live ? await walt!.balanceUsd() : paperEquity(state, price);
  const today = new Date().toISOString().slice(0, 10);
  if (state.day?.date !== today) state.day = { date: today, startEquity: equity };
  const ctx = { equityUsd: equity, openMarginUsd: 0, dayStartEquityUsd: state.day.startEquity };
  if (dailyLossExceeded(ctx, limits)) {
    state.paused = `perda diária >= ${limits.maxDailyLossPct}% ($${equity.toFixed(2)} vs $${state.day.startEquity.toFixed(2)}). Use /resume`;
    msgs.push(`🛑 Pausado: ${state.paused}`);
    return;
  }
  const decision = checkOpen(cfg.market, cfg.marginUsd, cfg.leverage, ctx, limits);
  if (!decision.ok) {
    const block = `entrada bloqueada pelo risco: ${decision.reason}`;
    if (block !== state.lastBlock) msgs.push(`🚫 ${block}`);
    state.lastBlock = block;
    return;
  }

  if (live) {
    try {
      await walt!.openLong(cfg.contract, cfg.marginUsd, cfg.leverage, price, plan.takeProfit, plan.stopLoss);
    } catch (e) {
      // não repetir: o guia do Walt avisa que retry cego pode abrir duas vezes
      state.paused = `falha ao abrir ordem (${(e as Error).message}). Confira /status e o app Walt, depois /resume`;
      msgs.push(`⏸️ Pausado: ${state.paused}`);
      return;
    }
  } else {
    state.paper.cash -= plan.qty * price * cfg.contract.takerFeePct;
  }
  grid.position = plan;
  state.lastBlock = undefined;
  await recordTrade(env, {
    at: plan.openedAt,
    market: cfg.market,
    event: "open",
    price,
    marginUsd: cfg.marginUsd,
    leverage: cfg.leverage,
    mode: state.mode,
  });
  msgs.push(
    `🔵 Long ${cfg.market} nível ${plan.level + 1} a ~$${price}: margem $${cfg.marginUsd} ${cfg.leverage}x | TP $${plan.takeProfit} | SL $${plan.stopLoss}${live ? "" : " (paper)"}`,
  );
}

/** Fecha a posição do grid e para (comando /closeall). */
export async function closeAll(env: Env): Promise<string> {
  const state = await loadState(env);
  if (!state.grid) return "Nenhum grid configurado.";
  const { cfg } = state.grid;
  const walt = await connectWalt(env);
  state.running = false;
  if (state.mode === "live") {
    if (!walt) return "Walt não conectado — feche a posição pelo app Walt.";
    if (await walt.openPosition(cfg.contract.contractId)) await walt.closePosition(cfg.contract.contractId);
    const pos = state.grid.position;
    if (pos) {
      const price = await currentPrice(cfg, walt);
      await recordClose(env, state, pos, price, positionPnl(pos, price, cfg.contract.takerFeePct), "manual");
    }
    state.grid.position = undefined;
    await saveState(env, state);
    return `Ordem de fechamento enviada para ${cfg.market}. Grid parado. Confira com /status.`;
  }
  const pos = state.grid.position;
  let msg = "Sem posição aberta. Grid parado.";
  if (pos) {
    const price = await currentPrice(cfg, walt);
    const pnl = positionPnl(pos, price, cfg.contract.takerFeePct);
    state.paper.cash += pnl;
    await recordClose(env, state, pos, price, pnl, "manual");
    state.grid.position = undefined;
    msg = `Posição paper fechada a $${price} (PnL $${pnl.toFixed(2)}). Grid parado.`;
  }
  await saveState(env, state);
  return msg;
}
