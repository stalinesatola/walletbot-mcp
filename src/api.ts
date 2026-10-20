// API JSON para a Mini App (via endpoints do Telegram Serverless) e para o encaminhamento de updates.
// Autenticação: header X-Api-Key igual ao secret API_SECRET.
import { closeAll, connectWalt, paperEquity, positionPnl } from "./bot";
import { handleUpdate } from "./commands";
import { riskLimits, type Env } from "./env";
import { loadTrades } from "./history";
import { getAccessToken } from "./oauth";
import { marketAllowed } from "./risk";
import { configureGrid, resumeGrid, runGrid, setMode, stopGrid, walt } from "./service";
import { cachedContracts, loadState } from "./state";
import { buyPrice, minMargin, notional, step, stopLossPrice } from "./strategy/grid";
import { timingSafeEqual, type TgUpdate } from "./telegram";
import { findContract } from "./walt";

type Json = Record<string, unknown>;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = req.headers.get("X-Api-Key") ?? "";
  if (!env.API_SECRET || !timingSafeEqual(key, env.API_SECRET)) return fail("unauthorized", 401);
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname.replace(/^\/api\//, "")}`;
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Json) : {};
  try {
    switch (route) {
      case "GET state":
        return json({ ok: true, ...(await stateView(env)) });
      case "GET contracts":
        return json({ ok: true, contracts: await contractsView(env) });
      case "GET price":
        return json({ ok: true, ...(await priceView(env, url.searchParams.get("market") ?? "", Number(url.searchParams.get("leverage") ?? 3))) });
      case "GET chart":
        return json({ ok: true, ...(await chartView(env, url.searchParams.get("market") ?? "")) });
      case "GET trades": {
        const s = await loadState(env);
        return json({ ok: true, trades: (await loadTrades(env)).slice().reverse(), equity: s.equity ?? [] });
      }
      case "POST grid": {
        const args = [body.market, body.low, body.high, body.levels, body.marginUsd, body.leverage].map((v) => String(v ?? ""));
        if (args.slice(0, 5).some((a) => a === "")) return fail("campos obrigatórios: market, low, high, levels, marginUsd");
        return json({ ok: true, message: await configureGrid(env, args) });
      }
      case "POST control":
        return json({ ok: true, message: await control(env, body) });
      case "POST telegram":
        // update encaminhado pelo handler do tgcloud; responde já e processa em segundo plano
        ctx.waitUntil(handleUpdate(env, body as unknown as TgUpdate));
        return json({ ok: true });
      default:
        return fail(`rota desconhecida: ${route}`, 404);
    }
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

async function control(env: Env, body: Json): Promise<string> {
  switch (body.action) {
    case "run":
      return runGrid(env);
    case "stop":
      return stopGrid(env);
    case "resume":
      return resumeGrid(env);
    case "closeall":
      return closeAll(env);
    case "mode":
      return setMode(env, [String(body.mode ?? ""), body.confirm === true ? "CONFIRMO" : ""]);
    default:
      throw new Error("action deve ser run, stop, resume, closeall ou mode");
  }
}

async function stateView(env: Env) {
  const s = await loadState(env);
  const limits = riskLimits(env);
  const connected = !!(await getAccessToken(env).catch(() => null));
  const grid = s.grid
    ? {
        ...s.grid.cfg,
        contract: undefined,
        contractId: s.grid.cfg.contract.contractId,
        step: step(s.grid.cfg),
        notional: notional(s.grid.cfg),
        stopLoss: stopLossPrice(s.grid.cfg, limits.stopLossPct),
        levelPrices: Array.from({ length: s.grid.cfg.levels + 1 }, (_, i) => buyPrice(s.grid!.cfg, i)),
      }
    : null;
  const pos = s.grid?.position;
  let live: Json | null = null;
  if (s.mode === "live" && s.grid && connected) {
    const w = await connectWalt(env);
    const p = await w?.openPosition(s.grid.cfg.contract.contractId).catch(() => null);
    if (p) live = { ...p.raw };
  }
  return {
    mode: s.mode,
    running: s.running,
    paused: s.paused ?? null,
    connected,
    lastPrice: s.lastPrice ?? null,
    lastTick: s.lastTick ?? null,
    lastError: s.lastError ?? null,
    lastBlock: s.lastBlock ?? null,
    stats: s.stats,
    grid,
    position: pos
      ? {
          ...pos,
          unrealizedPnl: s.lastPrice && s.grid ? positionPnl(pos, s.lastPrice, s.grid.cfg.contract.takerFeePct) : null,
        }
      : null,
    livePosition: live,
    paper: s.mode === "paper" ? { ...s.paper, equity: s.lastPrice ? paperEquity(s, s.lastPrice) : s.paper.cash } : null,
    limits,
  };
}

async function contractsView(env: Env) {
  const limits = riskLimits(env);
  const w = await walt(env);
  const list = await cachedContracts(env, () => w.contracts());
  return list
    .map((c) => {
      const market = c.name.replace(/-USDC?$/i, "");
      return {
        market,
        ...c,
        liquid: (c.volume24hUsd ?? 0) >= limits.minVolume24hUsd,
        allowed: marketAllowed(limits, market) && (c.volume24hUsd ?? 0) >= limits.minVolume24hUsd,
      };
    })
    .sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
}

async function priceView(env: Env, market: string, leverage: number) {
  const w = await walt(env);
  const contract = findContract(await cachedContracts(env, () => w.contracts()), market);
  if (!contract) throw new Error(`contrato ${market} não encontrado`);
  const price = await w.rate(contract);
  const lev = Math.max(1, Math.min(Math.trunc(leverage) || 1, contract.maxLeverage, riskLimits(env).maxLeverage));
  return {
    market: market.toUpperCase(),
    price,
    leverage: lev,
    minMargin: Number(minMargin(contract, price * 1.02, lev).toFixed(2)), // no topo da faixa sugerida (+2%)
    suggestion: { low: Number((price * 0.94).toFixed(contract.priceDecimals)), high: Number((price * 1.02).toFixed(contract.priceDecimals)) },
  };
}

/** Velas de 15 min da Hyperliquid (dados públicos) quando o par existe lá; senão, os preços gravados pelo tick. */
async function chartView(env: Env, market: string) {
  const m = market.toUpperCase();
  const end = Date.now();
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin: m, interval: "15m", startTime: end - 2 * 86_400_000, endTime: end } }),
    });
    if (res.ok) {
      const rows = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string }>;
      if (Array.isArray(rows) && rows.length)
        return { source: "hyperliquid", candles: rows.map((r) => [r.t, +r.o, +r.h, +r.l, +r.c]) };
    }
  } catch {
    // cai para os ticks gravados
  }
  const s = await loadState(env);
  const points = s.prices?.market === m ? s.prices.points : [];
  return { source: "ticks", candles: points.map(([t, p]) => [t, p, p, p, p]) };
}
