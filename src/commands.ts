import { riskLimits, type Env } from "./env";
import { closeAll, connectWalt, currentPrice, paperEquity } from "./bot";
import { callbackParams, disconnect, getAccessToken, handleCallback, startAuthorization } from "./oauth";
import { cachedContracts, defaultState, loadState, saveState, saveTools } from "./state";
import { notional, sizeError, step, stopLossPrice, validateConfig, type GridConfig } from "./strategy/grid";
import { COMMANDS } from "./telegram";
import { findContract, previewReason, type Walt } from "./walt";

/** Processa um comando do dono e devolve a resposta em texto. */
export async function handleCommand(env: Env, text: string): Promise<string> {
  // endereço do redirect colado sem /code
  if (!text.trim().startsWith("/") && /[?&]code=/.test(text) && /[?&]state=/.test(text)) text = `/code ${text}`;
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.replace(/^\//, "").replace(/@.*$/, "").toLowerCase();
  switch (cmd) {
    case "start":
    case "help":
      return help();
    case "status":
      return status(env);
    case "connect":
      return [
        "1) Abra o link, autorize no Walt e confirme no Telegram:",
        await startAuthorization(env),
        "",
        "2) O navegador vai abrir uma página http://localhost:8787/… que não carrega — é esperado.",
        "3) Copie o endereço completo dessa página e envie aqui (com ou sem /code).",
        "Faça em poucos minutos: o código expira rápido.",
      ].join("\n");
    case "code":
      if (!args.length) return "Uso: /code <endereço completo da página localhost após autorizar>";
      await handleCallback(env, callbackParams(args.join(" ")));
      return "✅ Walt conectado! Próximo passo: /conta para checar/criar a conta Perps do agente.";
    case "disconnect":
      await disconnect(env);
      return "Conta Walt desconectada.";
    case "conta":
      return conta(env, args[0] === "CONFIRMO");
    case "saldo":
      return `💰 ${JSON.stringify(await (await walt(env)).call("balance_get"), null, 1)}`;
    case "tools":
      return tools(env);
    case "call":
      return call(env, args);
    case "grid":
      return grid(env, args);
    case "run":
      return run(env);
    case "stop": {
      const s = await loadState(env);
      s.running = false;
      await saveState(env, s);
      return "Grid parado. A posição aberta (se houver) continua com TP/SL no Walt. /closeall para fechar.";
    }
    case "closeall":
      return closeAll(env);
    case "mode":
      return mode(env, args);
    case "risk":
      return risk(env);
    case "resume": {
      const s = await loadState(env);
      s.paused = undefined;
      s.day = undefined; // recomeça a contagem de perda diária
      await saveState(env, s);
      return "Pausa removida. O próximo tick roda normalmente.";
    }
    case "paper":
      return paperCmd(env, args);
    default:
      return `Comando desconhecido. ${help()}`;
  }
}

function help(): string {
  return [
    "🤖 walletbot-mcp — grid automático no Walt Perps",
    "",
    ...COMMANDS.map(([c, d]) => `/${c} — ${d}`),
    "/call <tool> [json] — chamar uma tool do Walt diretamente",
    "/paper reset [saldo] — reiniciar a carteira simulada",
    "/disconnect — remover tokens do Walt",
    "",
    "Fluxo: /connect → /conta → /grid … → /run (paper) → depositar USDC → /mode live CONFIRMO",
  ].join("\n");
}

async function walt(env: Env): Promise<Walt> {
  const w = await connectWalt(env);
  if (!w) throw new Error("Walt não conectado — use /connect");
  return w;
}

async function status(env: Env): Promise<string> {
  const s = await loadState(env);
  const connected = !!(await getAccessToken(env).catch(() => null));
  const lines = [
    `Modo: ${s.mode.toUpperCase()} | ${s.running ? "▶️ rodando" : "⏹️ parado"}${s.paused ? ` | ⏸️ ${s.paused}` : ""}`,
    `Walt: ${connected ? "conectado ✅" : "não conectado (/connect)"}`,
  ];
  if (s.grid) {
    const { cfg, position: p } = s.grid;
    lines.push(
      `Grid ${cfg.market} (#${cfg.contract.contractId}): $${cfg.low}–$${cfg.high}, ${cfg.levels} degraus de $${step(cfg).toFixed(cfg.contract.priceDecimals)}`,
      `Por trade: margem $${cfg.marginUsd} ${cfg.leverage}x (~$${notional(cfg).toFixed(2)} nocional)`,
      p
        ? `Posição: long nível ${p.level + 1} entrada ~$${p.entryPrice} | TP $${p.takeProfit} | SL $${p.stopLoss}`
        : "Posição: nenhuma (aguardando degrau)",
    );
  } else lines.push("Grid: não configurado (/grid)");
  if (s.lastPrice) lines.push(`Último preço: $${s.lastPrice}`);
  lines.push(
    `Trades ${s.stats.trades} (✅${s.stats.wins} ❌${s.stats.losses}) | PnL realizado ~$${s.stats.realizedPnl.toFixed(2)}`,
  );
  if (s.mode === "paper")
    lines.push(`Paper: patrimônio $${(s.lastPrice ? paperEquity(s, s.lastPrice) : s.paper.cash).toFixed(2)} (início $${s.paper.startCash})`);
  if (s.lastTick) lines.push(`Último tick: ${s.lastTick}`);
  if (s.lastError) lines.push(`Último erro: ${s.lastError}`);
  return lines.join("\n");
}

async function conta(env: Env, confirm: boolean): Promise<string> {
  const w = await walt(env);
  const r = await w.readiness();
  if (r.ok) return "✅ Conta Perps do agente pronta (perps_readiness ok). Deposite USDC no Walt antes do modo live.";
  const issues = r.issues.map((i) => `• ${i.code}: ${i.description ?? ""}`).join("\n");
  if (!r.issues.some((i) => i.code === "agent.account.not_found")) return `⚠️ Pendências:\n${issues}`;
  if (!confirm) {
    const p = await w.preview("perps_prepare_account_create", {});
    return [
      `A conta Perps deste agente ainda não existe:\n${issues}`,
      "",
      p.ok ? "Preview ok. Para criar, envie: /conta CONFIRMO" : `Preview recusado: ${previewReason(p)}`,
    ].join("\n");
  }
  await w.createAccount();
  return "Criação solicitada ✅ (é assíncrona). Rode /conta de novo em alguns segundos para confirmar.";
}

async function tools(env: Env): Promise<string> {
  const w = await walt(env);
  const list = await w.listTools();
  await saveTools(env, list);
  return [
    `Tools do Walt (${list.length}):`,
    ...list.map((t) => `• ${t.name}(${Object.keys(t.inputSchema?.properties ?? {}).join(", ")})`),
    "",
    "Schemas completos: /tools.json?secret=<TELEGRAM_WEBHOOK_SECRET>",
  ].join("\n");
}

async function call(env: Env, args: string[]): Promise<string> {
  const tool = args[0];
  if (!tool) return "Uso: /call <tool> [json]";
  if (tool === "perps_execute_operation") return "Use os comandos do bot para executar operações (evita execuções duplicadas).";
  let params: Record<string, unknown> = {};
  if (args.length > 1) {
    try {
      params = JSON.parse(args.slice(1).join(" "));
    } catch {
      return "JSON inválido.";
    }
  }
  const data = await (await walt(env)).call(tool, params);
  return `✅ ${tool}\n${typeof data === "string" ? data : JSON.stringify(data, null, 1)}`;
}

async function grid(env: Env, args: string[]): Promise<string> {
  const limits = riskLimits(env);
  const market = (args[0] ?? limits.allowedMarkets[0]).toUpperCase();
  if (!limits.allowedMarkets.includes(market)) return `Mercado fora da whitelist: ${limits.allowedMarkets.join(", ")}`;
  const w = await walt(env);
  const contract = findContract(await cachedContracts(env, () => w.contracts()), market);
  if (!contract) return `Contrato ${market}-USDC não encontrado no Walt.`;
  if (args.length < 5) {
    // sugestão pronta para copiar: faixa de −6% a +2% do preço atual
    const price = await w.rate(contract);
    const d = contract.priceDecimals;
    const lo = (price * 0.94).toFixed(d);
    const hi = (price * 1.02).toFixed(d);
    return [
      `Preço atual de ${market}: $${price}`,
      "",
      "Uso: /grid <mercado> <low> <high> <degraus> <margemUSD por trade> [alavancagem]",
      "Sugestão (faixa −6% a +2%, 8 degraus, $5 de margem, 3x) — copie e envie:",
      `/grid ${market} ${lo} ${hi} 8 5 3`,
    ].join("\n");
  }
  const cfg: GridConfig = {
    market,
    contract,
    low: Number(args[1]),
    high: Number(args[2]),
    levels: Number(args[3]),
    marginUsd: Number(args[4]),
    leverage: Math.min(Math.trunc(Number(args[5] ?? 1)), limits.maxLeverage),
  };
  const err = validateConfig(cfg);
  if (err) return `Config inválida: ${err}`;
  const s = await loadState(env);
  if (s.grid?.position) return "Há uma posição aberta no grid atual. Use /closeall antes de reconfigurar.";
  const price = await w.rate(contract);
  const sizeErr = sizeError(cfg, Math.min(price, cfg.high));
  if (sizeErr) return `Config inválida: ${sizeErr}`;
  s.grid = { cfg };
  s.running = false;
  await saveState(env, s);
  return [
    `Grid ${market} (contrato #${contract.contractId}) configurado:`,
    `• ${cfg.levels} degraus de $${step(cfg).toFixed(contract.priceDecimals)} entre $${cfg.low} e $${cfg.high} (preço atual $${price})`,
    `• Cada entrada: margem $${cfg.marginUsd} ${cfg.leverage}x ≈ $${notional(cfg).toFixed(2)} nocional, TP no degrau de cima`,
    `• Stop-loss: $${stopLossPrice(cfg, limits.stopLossPct).toFixed(contract.priceDecimals)} (para o grid)`,
    `Use /run para iniciar (modo ${s.mode}).`,
  ].join("\n");
}

async function run(env: Env): Promise<string> {
  const s = await loadState(env);
  if (!s.grid) return "Configure antes com /grid.";
  const price = await currentPrice(s.grid.cfg, await connectWalt(env));
  const { low, high } = s.grid.cfg;
  const warn =
    price > high || price < low ? `\n⚠️ Preço fora da faixa $${low}–$${high}: só entra quando o preço chegar nela.` : "";
  s.running = true;
  s.paused = undefined;
  s.lastPrice = price;
  await saveState(env, s);
  return `▶️ Grid ${s.grid.cfg.market} iniciado em modo ${s.mode.toUpperCase()} (preço $${price}). Ticks a cada 5 min.${warn}`;
}

async function mode(env: Env, args: string[]): Promise<string> {
  const s = await loadState(env);
  const target = args[0]?.toLowerCase();
  if (target !== "paper" && target !== "live") return `Modo atual: ${s.mode}. Uso: /mode paper | /mode live CONFIRMO`;
  if (s.grid?.position) return "Feche a posição (/closeall) antes de trocar de modo.";
  if (target === "live") {
    if (args[1] !== "CONFIRMO") return "⚠️ Live usa dinheiro real em perpétuos alavancados. Envie: /mode live CONFIRMO";
    const w = await walt(env);
    const r = await w.readiness();
    if (!r.ok) return `Conta Perps não está pronta: ${r.issues.map((i) => i.code).join(", ")} — use /conta.`;
    const bal = await w.balanceUsd();
    if (!(bal > 0)) return "Saldo USDC zero na conta do agente — deposite no Walt antes.";
  }
  s.mode = target;
  s.running = false;
  s.day = undefined;
  await saveState(env, s);
  return `Modo ${target.toUpperCase()} ativado. Grid parado — use /run.`;
}

function risk(env: Env): string {
  const l = riskLimits(env);
  return [
    "Travas de risco:",
    `• Alavancagem máx: ${l.maxLeverage}x`,
    `• Margem máx por trade: ${l.maxOrderPct}% do patrimônio`,
    `• Perda diária máx: ${l.maxDailyLossPct}% (pausa o bot)`,
    `• Stop-loss: ${l.stopLossPct}% abaixo do low do grid (no Walt, via autoClose)`,
    `• Mercados: ${l.allowedMarkets.join(", ")}`,
  ].join("\n");
}

async function paperCmd(env: Env, args: string[]): Promise<string> {
  if (args[0] !== "reset") return "Uso: /paper reset [saldo]";
  const s = await loadState(env);
  if (s.mode !== "paper") return "Só disponível no modo paper.";
  const cash = Number(args[1] ?? 1000);
  if (!(cash > 0)) return "Saldo inválido.";
  const fresh = defaultState();
  fresh.paper = { cash, startCash: cash };
  if (s.grid) fresh.grid = { cfg: s.grid.cfg };
  await saveState(env, fresh);
  return `Carteira paper reiniciada com $${cash}.`;
}
