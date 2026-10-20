import type { RiskLimits } from "./env";

export interface RiskContext {
  equityUsd: number;
  openMarginUsd: number;
  dayStartEquityUsd: number;
}

export type RiskDecision = { ok: true } | { ok: false; reason: string };

export function marketAllowed(limits: RiskLimits, market: string): boolean {
  return limits.allowedMarkets.includes("*") || limits.allowedMarkets.includes(market.toUpperCase());
}

export function dailyLossExceeded(ctx: RiskContext, limits: RiskLimits): boolean {
  if (!(ctx.dayStartEquityUsd > 0)) return false;
  const lossPct = ((ctx.dayStartEquityUsd - ctx.equityUsd) / ctx.dayStartEquityUsd) * 100;
  return lossPct >= limits.maxDailyLossPct;
}

/** Valida uma abertura. Fechamentos nunca são bloqueados. */
export function checkOpen(
  market: string,
  marginUsd: number,
  leverage: number,
  ctx: RiskContext,
  limits: RiskLimits,
): RiskDecision {
  if (!marketAllowed(limits, market))
    return { ok: false, reason: `mercado ${market} fora da whitelist (${limits.allowedMarkets.join(",")})` };
  if (leverage > limits.maxLeverage) return { ok: false, reason: `alavancagem ${leverage}x > máx ${limits.maxLeverage}x` };
  if (!(ctx.equityUsd > 0)) return { ok: false, reason: "patrimônio zero ou desconhecido (deposite USDC na conta do agente)" };
  if (dailyLossExceeded(ctx, limits)) return { ok: false, reason: `perda diária >= ${limits.maxDailyLossPct}%` };
  const maxMargin = (ctx.equityUsd * limits.maxOrderPct) / 100;
  if (marginUsd > maxMargin)
    return {
      ok: false,
      reason: `margem $${marginUsd.toFixed(2)} > ${limits.maxOrderPct}% do patrimônio ($${maxMargin.toFixed(2)})`,
    };
  if (ctx.openMarginUsd + marginUsd > (ctx.equityUsd * limits.maxTotalExposurePct) / 100)
    return { ok: false, reason: `exposição total passaria de ${limits.maxTotalExposurePct}% do patrimônio` };
  return { ok: true };
}
