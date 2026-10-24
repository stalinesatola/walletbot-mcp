import type { Env } from "./env";
import type { ContractInfo, GridConfig, GridPosition } from "./strategy/grid";

export interface BotState {
  mode: "paper" | "live";
  running: boolean;
  paused?: string; // motivo da pausa automática (perda diária, erro de execução)
  grid?: { cfg: GridConfig; position?: GridPosition };
  day?: { date: string; startEquity: number };
  paper: { cash: number; startCash: number };
  stats: { trades: number; wins: number; losses: number; realizedPnl: number };
  lastPrice?: number;
  lastTick?: string;
  lastError?: string;
  lastBlock?: string; // último bloqueio de risco (evita repetir a notificação)
  lastRecenter?: { at: string; low: number; high: number; price: number };
  // histórico curto para o gráfico/curva — fica no próprio estado para gastar uma escrita de KV por tick
  prices?: { market: string; points: Array<[number, number]> };
  equity?: Array<[number, number]>;
}

const K_STATE = "bot:state";
const K_TOOLS = "walt:tools";
const K_CONTRACTS = "walt:contracts:v2"; // v2: inclui volume e funding

export function defaultState(): BotState {
  return {
    mode: "paper",
    running: false,
    paper: { cash: 1000, startCash: 1000 },
    stats: { trades: 0, wins: 0, losses: 0, realizedPnl: 0 },
  };
}

export async function loadState(env: Env): Promise<BotState> {
  const saved = (await env.STATE.get<BotState>(K_STATE, "json")) ?? {};
  const s = { ...defaultState(), ...saved };
  s.stats = { ...defaultState().stats, ...s.stats };
  // estado da versão anterior (grid multi-nível) não é compatível
  if (s.grid && !(s.grid.cfg as Partial<GridConfig>).contract) s.grid = undefined;
  return s;
}

export async function saveState(env: Env, s: BotState): Promise<void> {
  await env.STATE.put(K_STATE, JSON.stringify(s));
}

/** Guarda o tools/list completo (descrições + schemas) para inspeção em /tools.json. */
export async function saveTools(env: Env, tools: unknown[]): Promise<void> {
  await env.STATE.put(K_TOOLS, JSON.stringify(tools));
}

export async function loadTools(env: Env): Promise<unknown[] | null> {
  return env.STATE.get<unknown[]>(K_TOOLS, "json");
}

export async function cachedContracts(env: Env, fetcher: () => Promise<ContractInfo[]>): Promise<ContractInfo[]> {
  const hit = await env.STATE.get<ContractInfo[]>(K_CONTRACTS, "json");
  if (hit?.length) return hit;
  const fresh = await fetcher();
  await env.STATE.put(K_CONTRACTS, JSON.stringify(fresh), { expirationTtl: 3600 });
  return fresh;
}

