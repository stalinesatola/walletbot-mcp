import type { RiskLimits } from "./env";

export interface RiskContext {
  equityUsd: number;
  openMarginUsd: number; // margem já usada pelas posições do grid
  dayStartEquityUsd: number;
}

export type RiskDecision = { ok: true; sizeUsd: number; leverage: number } | { ok: false; reason: string };

export function clampLeverage(leverage: number, limits: RiskLimits): number {
  return Math.max(1, Math.min(leverage, limits.maxLeverage));
}

export function dailyLossExceeded(ctx: RiskContext, limits: RiskLimits): boolean {
  if (!(ctx.dayStartEquityUsd > 0)) return false;
  const lossPct = ((ctx.dayStartEquityUsd - ctx.equityUsd) / ctx.dayStartEquityUsd) * 100;
  return lossPct >= limits.maxDailyLossPct;
}

/** Valida uma nova ordem de compra. Reduções de posição (vendas/stop) nunca são bloqueadas. */
export function checkOpen(
  market: string,
  sizeUsd: number,
  leverage: number,
  ctx: RiskContext,
  limits: RiskLimits,
): RiskDecision {
  if (!limits.allowedMarkets.includes(market.toUpperCase()))
    return { ok: false, reason: `mercado ${market} fora da whitelist (${limits.allowedMarkets.join(",")})` };
  if (!(ctx.equityUsd > 0)) return { ok: false, reason: "patrimônio zero ou desconhecido" };
  if (dailyLossExceeded(ctx, limits))
    return { ok: false, reason: `perda diária >= ${limits.maxDailyLossPct}%` };

  const lev = clampLeverage(leverage, limits);
  const margin = sizeUsd / lev;
  const maxMargin = (ctx.equityUsd * limits.maxOrderPct) / 100;
  if (margin > maxMargin)
    return {
      ok: false,
      reason: `margem da ordem $${margin.toFixed(2)} > ${limits.maxOrderPct}% do patrimônio ($${maxMargin.toFixed(2)})`,
    };
  const maxTotal = (ctx.equityUsd * limits.maxTotalExposurePct) / 100;
  if (ctx.openMarginUsd + margin > maxTotal)
    return { ok: false, reason: `exposição total passaria de ${limits.maxTotalExposurePct}% do patrimônio` };
  return { ok: true, sizeUsd, leverage: lev };
}
