import { describe, expect, it } from "vitest";
import type { RiskLimits } from "../src/env";
import { checkOpen, clampLeverage, dailyLossExceeded } from "../src/risk";

const limits: RiskLimits = {
  maxLeverage: 3,
  maxOrderPct: 5,
  maxTotalExposurePct: 50,
  maxDailyLossPct: 5,
  stopLossPct: 5,
  allowedMarkets: ["BTC", "ETH"],
};
const ctx = { equityUsd: 1000, openMarginUsd: 0, dayStartEquityUsd: 1000 };

describe("risk", () => {
  it("limita a alavancagem", () => {
    expect(clampLeverage(10, limits)).toBe(3);
    expect(clampLeverage(0, limits)).toBe(1);
  });

  it("aceita ordem dentro dos limites", () => {
    expect(checkOpen("BTC", 100, 2, ctx, limits)).toEqual({ ok: true, sizeUsd: 100, leverage: 2 });
  });

  it("bloqueia mercado fora da whitelist", () => {
    expect(checkOpen("DOGE", 10, 1, ctx, limits).ok).toBe(false);
  });

  it("bloqueia margem acima de 5% do patrimônio", () => {
    // 200 / 3x = 66,67 de margem > 50
    expect(checkOpen("BTC", 200, 10, ctx, limits)).toMatchObject({ ok: false });
    expect(checkOpen("BTC", 150, 3, ctx, limits).ok).toBe(true);
  });

  it("bloqueia exposição total acima de 50%", () => {
    expect(checkOpen("BTC", 100, 2, { ...ctx, openMarginUsd: 460 }, limits).ok).toBe(false);
  });

  it("detecta perda diária", () => {
    expect(dailyLossExceeded({ ...ctx, equityUsd: 951 }, limits)).toBe(false);
    expect(dailyLossExceeded({ ...ctx, equityUsd: 950 }, limits)).toBe(true);
    expect(checkOpen("BTC", 10, 1, { ...ctx, equityUsd: 900 }, limits).ok).toBe(false);
  });
});
