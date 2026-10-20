import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../src/bot";
import type { Env } from "../src/env";
import { defaultState, loadState, saveState } from "../src/state";
import type { GridConfig } from "../src/strategy/grid";

function memoryKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string, type?: string) => {
      const v = m.get(k);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  } as unknown as KVNamespace;
}

const env = (): Env => ({
  STATE: memoryKV(),
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_WEBHOOK_SECRET: "",
  OWNER_CHAT_ID: "",
  WALT_MCP_URL: "",
  WALT_AUTH_ISSUER: "",
  MAX_LEVERAGE: "3",
  MAX_ORDER_PCT: "5",
  MAX_TOTAL_EXPOSURE_PCT: "50",
  MAX_DAILY_LOSS_PCT: "5",
  STOP_LOSS_PCT: "5",
  ALLOWED_MARKETS: "BTC,ETH,SOL",
});

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
});
