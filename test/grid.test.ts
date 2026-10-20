import { describe, expect, it } from "vitest";
import {
  baseSize,
  entryLevel,
  exitHit,
  notional,
  planEntry,
  sizeError,
  validateConfig,
  type GridConfig,
} from "../src/strategy/grid";

// valores do contrato BTC-USDC do perps_list_contracts
const btc = {
  contractId: 1,
  name: "BTC-USDC",
  priceDecimals: 1,
  minSizeBase: 0.00007,
  minSizeQuote: 1,
  maxSizeQuote: 25000,
  maxLeverage: 50,
  takerFeePct: 0.0009,
  priceSlippage: 0.01,
};
const cfg: GridConfig = { market: "BTC", contract: btc, low: 100000, high: 110000, levels: 10, marginUsd: 5, leverage: 3 };

describe("grid de posição única", () => {
  it("valida a configuração contra o contrato", () => {
    expect(validateConfig(cfg)).toBeNull();
    expect(validateConfig({ ...cfg, high: 90000 })).toMatch(/faixa/);
    expect(validateConfig({ ...cfg, leverage: 2.5 })).toMatch(/inteiro/);
    expect(validateConfig({ ...cfg, leverage: 60 })).toMatch(/máx do contrato/);
    expect(validateConfig({ ...cfg, marginUsd: 0.5 })).toMatch(/mínima/);
  });

  it("acha o degrau cuja faixa contém o preço", () => {
    expect(entryLevel(cfg, 104500)).toBe(5); // (104000, 105000]
    expect(entryLevel(cfg, 100000)).toBe(0);
    expect(entryLevel(cfg, 99500)).toBe(0);
    expect(entryLevel(cfg, 98000)).toBeNull();
    expect(entryLevel(cfg, 110500)).toBeNull();
  });

  it("planeja TP no degrau de cima e SL abaixo da faixa, arredondados ao tick", () => {
    const p = planEntry(cfg, 104500, 5)!;
    expect(p.level).toBe(5);
    expect(p.takeProfit).toBe(106000);
    expect(p.stopLoss).toBe(95000);
    expect(exitHit(p, 106000)).toBe("tp");
    expect(exitHit(p, 95000)).toBe("sl");
    expect(exitHit(p, 104000)).toBeNull();
  });

  it("calcula nocional como o Walt (amount ÷ (1/alav + taxa))", () => {
    expect(notional(cfg)).toBeCloseTo(5 / (1 / 3 + 0.0009), 6);
    expect(baseSize(cfg, 100000)).toBeCloseTo(notional(cfg) / 101000, 10);
  });

  it("rejeita tamanho abaixo do mínimo do contrato", () => {
    expect(sizeError(cfg, 105000)).toBeNull(); // ~0.00014 BTC
    expect(sizeError({ ...cfg, marginUsd: 1, leverage: 1 }, 105000)).toMatch(/mínimo/);
  });
});
