import { describe, expect, it } from "vitest";
import { buildLevels, computeActions, validateConfig, type GridConfig } from "../src/strategy/grid";

const cfg: GridConfig = { market: "BTC", low: 60000, high: 70000, levels: 10, capitalUsd: 100, leverage: 2 };

describe("grid", () => {
  it("constrói níveis igualmente espaçados", () => {
    const levels = buildLevels(cfg);
    expect(levels).toHaveLength(10);
    expect(levels[0]).toEqual({ buyPrice: 60000, sellPrice: 61000 });
    expect(levels[9]).toEqual({ buyPrice: 69000, sellPrice: 70000 });
  });

  it("valida a configuração", () => {
    expect(validateConfig(cfg)).toBeNull();
    expect(validateConfig({ ...cfg, high: 50000 })).toMatch(/faixa/);
    expect(validateConfig({ ...cfg, levels: 1 })).toMatch(/níveis/);
  });

  it("compra só o nível cuja faixa contém o preço", () => {
    const actions = computeActions(cfg, buildLevels(cfg), 64500, 5);
    expect(actions).toEqual([{ type: "buy", level: 5, price: 64500, sizeUsd: 10 }]);
  });

  it("não sobe comprando níveis acima do preço em ticks seguidos", () => {
    const levels = buildLevels(cfg);
    levels[5] = { ...levels[5], qty: 0.0001, entryPrice: 64500 };
    expect(computeActions(cfg, levels, 64500, 5)).toEqual([]);
  });

  it("não compra acima da faixa", () => {
    expect(computeActions(cfg, buildLevels(cfg), 71000, 5)).toEqual([]);
  });

  it("vende nível cheio quando atinge o alvo e não recompra o mesmo nível", () => {
    const levels = buildLevels(cfg);
    levels[4] = { ...levels[4], qty: 0.001, entryPrice: 64000 };
    const actions = computeActions(cfg, levels, 65100, 5);
    expect(actions[0]).toEqual({ type: "sell", level: 4, price: 65100, qty: 0.001 });
    expect(actions.find((a) => a.type === "buy" && a.level === 4)).toBeUndefined();
  });

  it("dispara stop-loss abaixo de low - stop%", () => {
    const levels = buildLevels(cfg);
    levels[0] = { ...levels[0], qty: 0.001, entryPrice: 60000 };
    expect(computeActions(cfg, levels, 56900, 5)).toEqual([{ type: "stopLoss", price: 56900 }]);
    // sem posições, nada a fazer
    expect(computeActions(cfg, buildLevels(cfg), 56900, 5)).toEqual([]);
  });
});
