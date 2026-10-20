import { describe, expect, it } from "vitest";
import type { RiskLimits } from "../src/env";
import { checkOpen, dailyLossExceeded } from "../src/risk";

const limits: RiskLimits = {
  maxLeverage: 3,
  maxOrderPct: 5,
  maxTotalExposurePct: 50,
  maxDailyLossPct: 5,
  stopLossPct: 5,
  allowedMarkets: ["BTC", "ETH"],
};
const ctx = { equityUsd: 100, openMarginUsd: 0, dayStartEquityUsd: 100 };

describe("risk", () => {
  it("aceita margem até 5% do patrimônio", () => {
    expect(checkOpen("BTC", 5, 3, ctx, limits)).toEqual({ ok: true });
    expect(checkOpen("BTC", 6, 3, ctx, limits).ok).toBe(false);
  });

  it("bloqueia whitelist, alavancagem e saldo zero", () => {
    expect(checkOpen("DOGE", 1, 1, ctx, limits).ok).toBe(false);
    expect(checkOpen("BTC", 1, 5, ctx, limits).ok).toBe(false);
    expect(checkOpen("BTC", 1, 1, { ...ctx, equityUsd: 0 }, limits).ok).toBe(false);
  });

  it("detecta perda diária", () => {
    expect(dailyLossExceeded({ ...ctx, equityUsd: 95.1 }, limits)).toBe(false);
    expect(dailyLossExceeded({ ...ctx, equityUsd: 95 }, limits)).toBe(true);
  });
});
