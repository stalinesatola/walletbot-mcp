import type { Env } from "./env";
import type { GridConfig, GridLevel } from "./strategy/grid";
import type { ToolMap } from "./walt";

export interface BotState {
  mode: "paper" | "live";
  running: boolean;
  paused?: string; // motivo da pausa automática (perda diária, erro)
  grid?: { cfg: GridConfig; levels: GridLevel[] };
  day?: { date: string; startEquity: number };
  paper: { cash: number; startCash: number };
  stats: { buys: number; sells: number; realizedPnl: number };
  lastPrice?: number;
  lastTick?: string;
  lastError?: string;
  lastBlock?: string; // último bloqueio de risco (evita repetir a notificação)
}

const K_STATE = "bot:state";
const K_MAP = "walt:map";
const K_TOOLS = "walt:tools";
const K_LOCK = "bot:lock";

export const PAPER_FEE = 0.0005; // 0,05% por lado, simulado

export function defaultState(): BotState {
  return {
    mode: "paper",
    running: false,
    paper: { cash: 1000, startCash: 1000 },
    stats: { buys: 0, sells: 0, realizedPnl: 0 },
  };
}

export async function loadState(env: Env): Promise<BotState> {
  return { ...defaultState(), ...((await env.STATE.get<BotState>(K_STATE, "json")) ?? {}) };
}

export async function saveState(env: Env, s: BotState): Promise<void> {
  await env.STATE.put(K_STATE, JSON.stringify(s));
}

export async function loadMap(env: Env): Promise<ToolMap> {
  return (await env.STATE.get<ToolMap>(K_MAP, "json")) ?? { bindings: {}, confirmed: false };
}

export async function saveMap(env: Env, m: ToolMap): Promise<void> {
  await env.STATE.put(K_MAP, JSON.stringify(m));
}

/** Guarda o tools/list completo (descrições + schemas) para inspeção em /tools.json. */
export async function saveTools(env: Env, tools: unknown[]): Promise<void> {
  await env.STATE.put(K_TOOLS, JSON.stringify(tools));
}

export async function loadTools(env: Env): Promise<unknown[] | null> {
  return env.STATE.get<unknown[]>(K_TOOLS, "json");
}

/** Lock best-effort (KV é eventualmente consistente; o cron de 5 min dá folga). */
export async function acquireLock(env: Env): Promise<boolean> {
  if (await env.STATE.get(K_LOCK)) return false;
  await env.STATE.put(K_LOCK, new Date().toISOString(), { expirationTtl: 240 });
  return true;
}

export async function releaseLock(env: Env): Promise<void> {
  await env.STATE.delete(K_LOCK);
}

/** Métricas das posições do grid ao preço atual. */
export function gridExposure(levels: GridLevel[], price: number, leverage: number) {
  let unrealized = 0;
  let margin = 0;
  let qty = 0;
  for (const l of levels) {
    if (!l.qty || !l.entryPrice) continue;
    unrealized += l.qty * (price - l.entryPrice);
    margin += (l.qty * l.entryPrice) / leverage;
    qty += l.qty;
  }
  return { unrealized, margin, qty };
}
