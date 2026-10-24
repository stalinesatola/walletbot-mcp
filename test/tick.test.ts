import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../src/bot";
import { env } from "./helpers";
import { defaultState, loadState, saveState } from "../src/state";
import type { GridConfig } from "../src/strategy/grid";

const cfg: GridConfig = {
  market: "BTC",
  contract: { contractId: 1, name: "BTC-USDC", priceDecimals: 1, minSizeBase: 0.00007, minSizeQuote: 1, maxSizeQuote: 25000, maxLeverage: 50, takerFeePct: 0.0009, priceSlippage: 0.01 },
  low: 100000,
  high: 110000,
  levels: 10,
  marginUsd: 5,
  leverage: 3,
};

// sem Walt conectado o paper usa o preço público (Hyperliquid) — simulado aqui
function priceIs(p: number) {
  vi.stubGlobal("fetch", async () => Response.json({ BTC: String(p) }));
}

afterEach(() => vi.unstubAllGlobals());

describe("tick paper", () => {
  it("entra no degrau, realiza TP, reentra e para no stop-loss", async () => {
    const e = env();
    const s = defaultState();
    s.grid = { cfg };
    s.running = true;
    await saveState(e, s);

    priceIs(104500);
    expect((await tick(e))[0]).toMatch(/Long BTC nível 6/);
    expect((await loadState(e)).grid?.position?.takeProfit).toBe(106000);

    priceIs(105000);
    expect(await tick(e)).toEqual([]); // posição aberta, nada a fazer

    priceIs(106100);
    const tp = await tick(e);
    expect(tp[0]).toMatch(/Take-profit/);
    expect(tp[1]).toMatch(/Long BTC nível 8/); // reentra no degrau do preço atual (106000, 107000]
    let st = await loadState(e);
    expect(st.stats.wins).toBe(1);
    expect(st.paper.cash).toBeGreaterThan(1000);

    priceIs(94000);
    expect((await tick(e))[0]).toMatch(/Stop-loss/);
    st = await loadState(e);
    expect(st.running).toBe(false);
    expect(st.grid?.position).toBeUndefined();
    expect(st.stats.losses).toBe(1);
  });

  it("não entra acima de 5% do patrimônio", async () => {
    const e = env();
    const s = defaultState();
    s.paper = { cash: 50, startCash: 50 };
    s.grid = { cfg };
    s.running = true;
    await saveState(e, s);
    priceIs(104500);
    expect((await tick(e))[0]).toMatch(/bloqueada pelo risco/);
    expect((await loadState(e)).grid?.position).toBeUndefined();
  });

  it("recentra quando o preço passa do high sem posição e entra no mesmo tick", async () => {
    const e = env();
    const s = defaultState();
    s.grid = { cfg };
    s.running = true;
    await saveState(e, s);
    priceIs(120000);
    const msgs = await tick(e);
    expect(msgs[0]).toMatch(/recentrado: \$112800–\$122400/);
    expect(msgs[1]).toMatch(/Long BTC/);
    const st = await loadState(e);
    expect(st.grid?.cfg.low).toBe(112800);
    expect(st.lastRecenter?.price).toBe(120000);
  });

  it("não recentra com posição aberta", async () => {
    const e = env();
    const s = defaultState();
    s.grid = { cfg };
    s.running = true;
    await saveState(e, s);
    priceIs(104500);
    await tick(e); // abre no degrau
    priceIs(105500); // abaixo do TP (106000), dentro da faixa
    await tick(e);
    priceIs(130000); // TP acontece; o recentro só vem sem posição
    const msgs = await tick(e);
    expect(msgs[0]).toMatch(/Take-profit/);
    expect(msgs[1]).toMatch(/recentrado/);
  });

  it("com AUTO_RECENTER=false só avisa, uma vez", async () => {
    const e = { ...env(), AUTO_RECENTER: "false" };
    const s = defaultState();
    s.grid = { cfg };
    s.running = true;
    await saveState(e, s);
    priceIs(120000);
    expect((await tick(e))[0]).toMatch(/fora da faixa/);
    expect(await tick(e)).toEqual([]);
    expect((await loadState(e)).grid?.cfg.low).toBe(100000);
  });
});
