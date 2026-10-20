// Grid de posição única para o Walt Perps (uma posição por contrato, sem aumentar posição):
// quando o preço cai num degrau, abre um long com take-profit no degrau de cima e
// stop-loss abaixo da faixa — TP/SL ficam no Walt (autoClose), não dependem do bot.
// Funções puras — sem I/O.

export interface ContractInfo {
  contractId: number; // 0 é um contrato válido (ETH)
  name: string; // ex.: "BTC-USDC"
  priceDecimals: number;
  minSizeBase: number;
  minSizeQuote: number;
  maxSizeQuote: number;
  maxLeverage: number;
  takerFeePct: number;
  priceSlippage: number;
  volume24hUsd?: number;
  fundingRateHourly?: number;
}

export interface GridConfig {
  market: string; // base asset, ex.: "BTC"
  contract: ContractInfo;
  low: number;
  high: number;
  levels: number;
  marginUsd: number; // margem (USDC) por trade — é o `amount` do Walt
  leverage: number; // inteiro
}

export interface GridPosition {
  level: number;
  entryPrice: number;
  qty: number; // estimativa em base asset
  marginUsd: number;
  takeProfit: number;
  stopLoss: number;
  openedAt: string;
}

export function validateConfig(cfg: GridConfig): string | null {
  if (!(cfg.low > 0) || !(cfg.high > cfg.low)) return "faixa inválida: precisa 0 < low < high";
  if (!Number.isInteger(cfg.levels) || cfg.levels < 2 || cfg.levels > 50) return "níveis devem ser inteiro entre 2 e 50";
  if (!Number.isInteger(cfg.leverage) || cfg.leverage < 1) return "alavancagem deve ser inteiro >= 1";
  if (cfg.leverage > cfg.contract.maxLeverage) return `alavancagem máx do contrato é ${cfg.contract.maxLeverage}x`;
  if (cfg.marginUsd < cfg.contract.minSizeQuote) return `margem mínima por trade é $${cfg.contract.minSizeQuote}`;
  if (cfg.marginUsd > cfg.contract.maxSizeQuote) return `margem máxima por trade é $${cfg.contract.maxSizeQuote}`;
  return null;
}

export function step(cfg: GridConfig): number {
  return (cfg.high - cfg.low) / cfg.levels;
}

export function buyPrice(cfg: GridConfig, level: number): number {
  return cfg.low + step(cfg) * level;
}

export function stopLossPrice(cfg: GridConfig, stopLossPct: number): number {
  return cfg.low * (1 - stopLossPct / 100);
}

/** Nível cuja faixa (buyPrice − passo, buyPrice] contém o preço, ou null fora do grid. */
export function entryLevel(cfg: GridConfig, price: number): number | null {
  const s = step(cfg);
  for (let i = 0; i < cfg.levels; i++) {
    const b = buyPrice(cfg, i);
    if (price <= b && price > b - s) return i;
  }
  return null;
}

/** Nocional que o Walt abre com essa margem: amount ÷ (1/alavancagem + taxa taker). */
export function notional(cfg: GridConfig): number {
  return cfg.marginUsd / (1 / cfg.leverage + cfg.contract.takerFeePct);
}

/** Tamanho estimado em base asset no pior preço (preço + slippage). */
export function baseSize(cfg: GridConfig, price: number): number {
  return notional(cfg) / (price * (1 + cfg.contract.priceSlippage));
}

export function sizeError(cfg: GridConfig, price: number): string | null {
  const size = baseSize(cfg, price);
  if (size < cfg.contract.minSizeBase)
    return `tamanho ${size.toPrecision(3)} ${cfg.market} < mínimo ${cfg.contract.minSizeBase}; aumente margem ou alavancagem`;
  return null;
}

export function planEntry(cfg: GridConfig, price: number, stopLossPct: number): GridPosition | null {
  const level = entryLevel(cfg, price);
  if (level === null) return null;
  return {
    level,
    entryPrice: price,
    qty: notional(cfg) / price,
    marginUsd: cfg.marginUsd,
    takeProfit: roundPrice(buyPrice(cfg, level) + step(cfg), cfg.contract.priceDecimals),
    stopLoss: roundPrice(stopLossPrice(cfg, stopLossPct), cfg.contract.priceDecimals),
    openedAt: new Date().toISOString(),
  };
}

export function exitHit(pos: GridPosition, price: number): "tp" | "sl" | null {
  if (price >= pos.takeProfit) return "tp";
  if (price <= pos.stopLoss) return "sl";
  return null;
}

export function roundPrice(p: number, decimals: number): number {
  return Number(p.toFixed(decimals));
}

/** Margem mínima (USDC) para abrir no contrato a `price` com `leverage` — o maior entre min_size_quote e o tamanho mínimo. */
export function minMargin(contract: ContractInfo, price: number, leverage: number): number {
  const minNotional = contract.minSizeBase * price * (1 + contract.priceSlippage);
  return Math.max(contract.minSizeQuote, minNotional * (1 / leverage + contract.takerFeePct));
}
