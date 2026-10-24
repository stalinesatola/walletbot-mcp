import { riskLimits, type Env } from "./env";
import { closeAll, paperEquity } from "./bot";
import { configureGrid, resumeGrid, runGrid, setMode, stopGrid, walt } from "./service";
import { callbackParams, disconnect, getAccessToken, handleCallback, startAuthorization } from "./oauth";
import { defaultState, loadState, saveState, saveTools } from "./state";
import { notional, step } from "./strategy/grid";
import { COMMANDS, notifyOwner, send, type TgUpdate } from "./telegram";
import { previewReason } from "./walt";

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
      return configureGrid(env, args);
    case "run":
      return runGrid(env);
    case "stop":
      return stopGrid(env);
    case "closeall":
      return closeAll(env);
    case "mode":
      return setMode(env, args);
    case "risk":
      return risk(env);
    case "testalert":
      await notifyOwner(env, ["🔔 Teste de alerta do walletbot-mcp."]);
      return env.ALERT_CHAT_ID ? `Alerta de teste enviado para ${env.ALERT_CHAT_ID}.` : "Alerta de teste enviado (sem ALERT_CHAT_ID: vai para você).";
    case "resume":
      return resumeGrid(env);
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
    "/testalert — testar o envio de alertas para o canal",
    "",
    "Fluxo: /connect → /conta → /grid … → /run (paper) → depositar USDC → /mode live CONFIRMO",
  ].join("\n");
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
  if (s.lastRecenter)
    lines.push(`Último recentro: ${s.lastRecenter.at} → $${s.lastRecenter.low}–$${s.lastRecenter.high} (preço $${s.lastRecenter.price})`);
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




function risk(env: Env): string {
  const l = riskLimits(env);
  return [
    "Travas de risco:",
    `• Alavancagem máx: ${l.maxLeverage}x`,
    `• Margem máx por trade: ${l.maxOrderPct}% do patrimônio`,
    `• Perda diária máx: ${l.maxDailyLossPct}% (pausa o bot)`,
    `• Stop-loss: ${l.stopLossPct}% abaixo do low do grid (no Walt, via autoClose)`,
    `• Mercados: ${l.allowedMarkets.join(", ")}`,
    `• Recentro automático: ${l.autoRecenter ? `ligado (−${l.recenterDownPct}% / +${l.recenterUpPct}% do preço)` : "desligado"}`,
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

/** Processa um update do Telegram (webhook direto ou encaminhado pelo tgcloud). */
export async function handleUpdate(env: Env, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);
  if (!env.OWNER_CHAT_ID) {
    await send(env, chatId, `Seu chat id é ${chatId}. Configure o secret OWNER_CHAT_ID com esse valor.`);
    return;
  }
  if (chatId !== env.OWNER_CHAT_ID) return; // só o dono controla o bot
  let reply: string;
  try {
    reply = await handleCommand(env, msg.text);
  } catch (e) {
    reply = `❌ ${(e as Error).message}`;
  }
  await send(env, chatId, reply);
}
