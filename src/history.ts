// Histórico para a Mini App. O KV grátis permite 1000 escritas/dia, então preços e patrimônio
// ficam dentro do BotState (salvo uma vez por tick) e os trades numa chave própria, gravada só em eventos.
import type { Env } from "./env";
import type { BotState } from "./state";

export interface TradeRecord {
  at: string;
  market: string;
  event: "open" | "close";
  price: number;
  marginUsd: number;
  leverage: number;
  pnl?: number;
  reason?: "tp" | "sl" | "manual";
  mode: "paper" | "live";
}

const K_TRADES = "hist:trades";
export const MAX_TRADES = 300;
export const MAX_PRICES = 288; // 24 h com tick de 5 min
export const MAX_EQUITY = 500;
const EQUITY_EVERY_MS = 3_600_000; // um ponto por hora (mais um por trade fechado)

export async function recordTrade(env: Env, rec: TradeRecord): Promise<void> {
  const list = await loadTrades(env);
  list.push(rec);
  await env.STATE.put(K_TRADES, JSON.stringify(list.slice(-MAX_TRADES)));
}

export async function loadTrades(env: Env): Promise<TradeRecord[]> {
  return (await env.STATE.get<TradeRecord[]>(K_TRADES, "json")) ?? [];
}

/** Acrescenta um preço do par ativo (zera o buffer ao trocar de par). */
export function pushPrice(state: BotState, market: string, price: number, now = Date.now()): void {
  if (state.prices?.market !== market) state.prices = { market, points: [] };
  state.prices.points.push([now, price]);
  if (state.prices.points.length > MAX_PRICES) state.prices.points.splice(0, state.prices.points.length - MAX_PRICES);
}

/** Ponto de patrimônio: no máximo um por hora, a não ser que `force` (trade fechado). */
export function pushEquity(state: BotState, equity: number, force = false, now = Date.now()): void {
  const list = (state.equity ??= []);
  const last = list[list.length - 1];
  if (!force && last && now - last[0] < EQUITY_EVERY_MS) return;
  list.push([now, Number(equity.toFixed(4))]);
  if (list.length > MAX_EQUITY) list.splice(0, list.length - MAX_EQUITY);
}
