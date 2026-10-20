// Grid/DCA long-only: compra em cada nível ao cair, vende no nível de cima ao subir.
// Funções puras — sem I/O — para serem testadas isoladamente.

export interface GridConfig {
  market: string;
  low: number;
  high: number;
  levels: number; // número de níveis de compra
  capitalUsd: number; // nocional total do grid
  leverage: number;
}

export interface GridLevel {
  buyPrice: number;
  sellPrice: number;
  // preenchido quando há posição aberta neste nível
  qty?: number;
  entryPrice?: number;
}

export type GridAction =
  | { type: "buy"; level: number; price: number; sizeUsd: number }
  | { type: "sell"; level: number; price: number; qty: number }
  | { type: "stopLoss"; price: number };

export function validateConfig(cfg: GridConfig): string | null {
  if (!(cfg.low > 0) || !(cfg.high > cfg.low)) return "faixa inválida: precisa 0 < low < high";
  if (!Number.isInteger(cfg.levels) || cfg.levels < 2 || cfg.levels > 50)
    return "níveis devem ser inteiro entre 2 e 50";
  if (!(cfg.capitalUsd > 0)) return "capital deve ser > 0";
  if (!(cfg.leverage >= 1)) return "alavancagem deve ser >= 1";
  return null;
}

/** Níveis de compra igualmente espaçados de low até o penúltimo degrau; venda no degrau seguinte. */
export function buildLevels(cfg: GridConfig): GridLevel[] {
  const step = (cfg.high - cfg.low) / cfg.levels;
  const levels: GridLevel[] = [];
  for (let i = 0; i < cfg.levels; i++) {
    levels.push({ buyPrice: round(cfg.low + step * i), sellPrice: round(cfg.low + step * (i + 1)) });
  }
  return levels;
}

export function perLevelUsd(cfg: GridConfig): number {
  return cfg.capitalUsd / cfg.levels;
}

/**
 * Decide o que fazer com o preço atual.
 * - Abaixo de low*(1-stopLossPct) → stop-loss geral.
 * - Nível vazio cuja faixa (buyPrice - passo, buyPrice] contém o preço → compra.
 *   As faixas são disjuntas, então no máximo um nível compra por tick e um gap
 *   grande não despeja todo o capital de uma vez.
 * - Nível cheio com preço >= sellPrice → vende.
 */
export function computeActions(
  cfg: GridConfig,
  levels: GridLevel[],
  price: number,
  stopLossPct: number,
): GridAction[] {
  if (price <= cfg.low * (1 - stopLossPct / 100)) {
    return levels.some((l) => l.qty) ? [{ type: "stopLoss", price }] : [];
  }
  const step = (cfg.high - cfg.low) / cfg.levels;
  const actions: GridAction[] = [];
  levels.forEach((l, i) => {
    if (l.qty && price >= l.sellPrice) actions.push({ type: "sell", level: i, price, qty: l.qty });
  });
  const i = levels.findIndex((l) => price <= l.buyPrice && price > l.buyPrice - step);
  if (i >= 0 && !levels[i].qty) actions.push({ type: "buy", level: i, price, sizeUsd: perLevelUsd(cfg) });
  return actions;
}

function round(n: number): number {
  return Number(n.toPrecision(10));
}
