import { riskLimits, type Env } from "./env";
import { closeAll, connectWalt, currentPrice } from "./bot";
import { McpClient, resultText } from "./mcp";
import { callbackParams, disconnect, getAccessToken, handleCallback, startAuthorization } from "./oauth";
import { PaperExecutor } from "./paper";
import { gridExposure, loadMap, loadState, saveMap, saveState, saveTools, defaultState } from "./state";
import { buildLevels, validateConfig, type GridConfig } from "./strategy/grid";
import { COMMANDS } from "./telegram";
import { ROLES, proposeMap, type Role } from "./walt";

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
        "3) Copie o endereço completo dessa página e envie aqui: /code <endereço>",
        "Faça em poucos minutos: o código expira rápido.",
      ].join("\n");
    case "code":
      if (!args.length) return "Uso: /code <endereço completo da página localhost após autorizar>";
      await handleCallback(env, callbackParams(args.join(" ")));
      return "✅ Walt conectado! Use /tools para ver as tools e revisar o mapeamento.";
    case "disconnect":
      await disconnect(env);
      return "Conta Walt desconectada.";
    case "tools":
      return tools(env, args[0] === "refresh");
    case "map":
      return map(env, args);
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
      return "Grid parado. Posições abertas foram mantidas (/closeall para fechar).";
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
    "🤖 walletbot-mcp — auto trade Grid/DCA via Walt MCP",
    "",
    ...COMMANDS.map(([c, d]) => `/${c} — ${d}`),
    "/map <role> <tool> [json] — mapear tool (roles: price, account, open, close)",
    "/map confirm — confirmar o mapeamento (obrigatório para live)",
    "/call <tool> [json] — chamar uma tool do Walt diretamente",
    "/paper reset [saldo] — reiniciar a carteira simulada",
    "/disconnect — remover tokens do Walt",
    "",
    "Fluxo: /connect → /tools → /map confirm → /grid … → /run (paper) → /mode live CONFIRMO",
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
    const { cfg, levels } = s.grid;
    const price = s.lastPrice;
    const filled = levels.filter((l) => l.qty).length;
    lines.push(
      `Grid ${cfg.market}: $${cfg.low}–$${cfg.high}, ${cfg.levels} níveis, $${cfg.capitalUsd} (${cfg.leverage}x)`,
      `Níveis cheios: ${filled}/${levels.length}`,
    );
    if (price) {
      const exp = gridExposure(levels, price, cfg.leverage);
      lines.push(`Último preço: $${price} | PnL aberto $${exp.unrealized.toFixed(2)} | margem $${exp.margin.toFixed(2)}`);
    }
  } else lines.push("Grid: não configurado (/grid)");
  lines.push(`Compras ${s.stats.buys} | Vendas ${s.stats.sells} | PnL realizado $${s.stats.realizedPnl.toFixed(2)}`);
  if (s.mode === "paper") {
    const eq = s.lastPrice ? await new PaperExecutor(s).equity(s.lastPrice) : s.paper.cash;
    lines.push(`Paper: patrimônio $${eq.toFixed(2)} (início $${s.paper.startCash})`);
  }
  if (s.lastTick) lines.push(`Último tick: ${s.lastTick}`);
  if (s.lastError) lines.push(`Último erro: ${s.lastError}`);
  return lines.join("\n");
}

async function client(env: Env): Promise<McpClient> {
  const token = await getAccessToken(env);
  if (!token) throw new Error("Walt não conectado — use /connect");
  return new McpClient(env.WALT_MCP_URL, token);
}

async function tools(env: Env, refresh: boolean): Promise<string> {
  const list = await (await client(env)).listTools();
  await saveTools(env, list);
  let current = await loadMap(env);
  if (refresh || Object.keys(current.bindings).length === 0) {
    current = proposeMap(list);
    await saveMap(env, current);
  }
  const lines = [`Tools do Walt (${list.length}):`];
  for (const t of list) {
    const params = Object.keys(t.inputSchema?.properties ?? {}).join(", ");
    lines.push(`• ${t.name}(${params})${t.description ? ` — ${t.description.slice(0, 120)}` : ""}`);
  }
  lines.push("", mapText(current));
  return lines.join("\n");
}

function mapText(m: Awaited<ReturnType<typeof loadMap>>): string {
  const lines = [`Mapeamento ${m.confirmed ? "✅ confirmado" : "⚠️ NÃO confirmado"}:`];
  for (const role of ROLES) {
    const b = m.bindings[role];
    lines.push(`${role}: ${b ? `${b.tool} ${JSON.stringify(b.args)}` : "—"}`);
  }
  if (!m.confirmed) lines.push("Revise e ajuste com /map <role> <tool> <json>, depois /map confirm.");
  return lines.join("\n");
}

async function map(env: Env, args: string[]): Promise<string> {
  const m = await loadMap(env);
  if (args.length === 0) return mapText(m);
  if (args[0] === "confirm") {
    m.confirmed = true;
    await saveMap(env, m);
    return mapText(m);
  }
  const role = args[0] as Role;
  if (!ROLES.includes(role)) return `Role inválida. Use: ${ROLES.join(", ")}`;
  const tool = args[1];
  if (!tool) return "Uso: /map <role> <tool> [json com {market} {sizeUsd} {qty} {leverage} {price}]";
  let templ: Record<string, unknown> = m.bindings[role]?.tool === tool ? m.bindings[role]!.args : {};
  if (args.length > 2) {
    try {
      templ = JSON.parse(args.slice(2).join(" "));
    } catch {
      return "JSON inválido.";
    }
  }
  m.bindings[role] = { tool, args: templ };
  m.confirmed = false; // qualquer mudança exige nova confirmação
  await saveMap(env, m);
  return mapText(m);
}

async function call(env: Env, args: string[]): Promise<string> {
  const tool = args[0];
  if (!tool) return "Uso: /call <tool> [json]";
  let params: Record<string, unknown> = {};
  if (args.length > 1) {
    try {
      params = JSON.parse(args.slice(1).join(" "));
    } catch {
      return "JSON inválido.";
    }
  }
  const result = await (await client(env)).callTool(tool, params);
  return `${result.isError ? "❌" : "✅"} ${tool}\n${resultText(result)}`;
}

async function grid(env: Env, args: string[]): Promise<string> {
  if (args.length < 5) return "Uso: /grid <mercado> <low> <high> <níveis> <capitalUSD> [alavancagem]\nEx.: /grid BTC 60000 70000 10 100 2";
  const limits = riskLimits(env);
  const cfg: GridConfig = {
    market: args[0].toUpperCase(),
    low: Number(args[1]),
    high: Number(args[2]),
    levels: Number(args[3]),
    capitalUsd: Number(args[4]),
    leverage: Math.min(Number(args[5] ?? 1), limits.maxLeverage),
  };
  const err = validateConfig(cfg);
  if (err) return `Config inválida: ${err}`;
  if (!limits.allowedMarkets.includes(cfg.market)) return `Mercado fora da whitelist: ${limits.allowedMarkets.join(", ")}`;
  const s = await loadState(env);
  if (s.grid?.levels.some((l) => l.qty)) return "Há posições abertas no grid atual. Use /closeall antes de reconfigurar.";
  s.grid = { cfg, levels: buildLevels(cfg) };
  s.running = false;
  await saveState(env, s);
  const per = cfg.capitalUsd / cfg.levels;
  return [
    `Grid ${cfg.market} configurado: ${cfg.levels} níveis de $${per.toFixed(2)} entre $${cfg.low} e $${cfg.high}, ${cfg.leverage}x.`,
    `Stop-loss: abaixo de $${(cfg.low * (1 - limits.stopLossPct / 100)).toFixed(2)}.`,
    `Use /run para iniciar (modo ${s.mode}).`,
  ].join("\n");
}

async function run(env: Env): Promise<string> {
  const s = await loadState(env);
  if (!s.grid) return "Configure antes com /grid.";
  const price = await currentPrice(env, s.grid.cfg.market, await connectWalt(env));
  const warn =
    price > s.grid.cfg.high || price < s.grid.cfg.low
      ? `\n⚠️ Preço fora da faixa $${s.grid.cfg.low}–$${s.grid.cfg.high}: o grid só compra quando o preço entrar nela.`
      : "";
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
  if (s.grid?.levels.some((l) => l.qty)) return "Feche as posições (/closeall) antes de trocar de modo.";
  if (target === "live") {
    if (args[1] !== "CONFIRMO") return "⚠️ Live usa dinheiro real em perpétuos alavancados. Envie: /mode live CONFIRMO";
    const m = await loadMap(env);
    if (!m.confirmed) return "Confirme o mapeamento antes (/tools, depois /map confirm).";
    if (!(await getAccessToken(env))) return "Conecte o Walt antes (/connect).";
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
    `• Margem máx por ordem: ${l.maxOrderPct}% do patrimônio`,
    `• Margem total máx: ${l.maxTotalExposurePct}% do patrimônio`,
    `• Perda diária máx: ${l.maxDailyLossPct}% (pausa o bot)`,
    `• Stop-loss: ${l.stopLossPct}% abaixo do low do grid`,
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
  if (s.grid) fresh.grid = { cfg: s.grid.cfg, levels: buildLevels(s.grid.cfg) };
  await saveState(env, fresh);
  return `Carteira paper reiniciada com $${cash}.`;
}
