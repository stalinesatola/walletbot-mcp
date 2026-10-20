import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api";
import type { RiskLimits } from "../src/env";
import { MAX_PRICES, pushEquity, pushPrice } from "../src/history";
import { marketAllowed } from "../src/risk";
import { defaultState, saveState } from "../src/state";
import { minMargin } from "../src/strategy/grid";
import { env } from "./helpers";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = (e: ReturnType<typeof env>, path: string, key?: string, init: RequestInit = {}) =>
  handleApi(new Request(`https://w.dev/api/${path}`, { ...init, headers: key ? { "X-Api-Key": key } : {} }), e, ctx);

describe("API da Mini App", () => {
  it("exige X-Api-Key correta", async () => {
    const e = env();
    expect((await call(e, "state")).status).toBe(401);
    expect((await call(e, "state", "errada")).status).toBe(401);
    expect((await call(e, "state", "chave-teste")).status).toBe(200);
  });

  it("recusa tudo se API_SECRET não estiver configurado", async () => {
    const e = { ...env(), API_SECRET: "" };
    expect((await call(e, "state", "")).status).toBe(401);
  });

  it("devolve estado, histórico e 404 para rota desconhecida", async () => {
    const e = env();
    const s = defaultState();
    pushEquity(s, 1000);
    await saveState(e, s);
    const st = (await (await call(e, "state", "chave-teste")).json()) as { mode: string; grid: unknown };
    expect(st.mode).toBe("paper");
    expect(st.grid).toBeNull();
    const tr = (await (await call(e, "trades", "chave-teste")).json()) as { trades: unknown[]; equity: unknown[] };
    expect(tr.trades).toEqual([]);
    expect(tr.equity).toHaveLength(1);
    expect((await call(e, "nada", "chave-teste")).status).toBe(404);
  });

  it("valida campos do grid", async () => {
    const res = await call(env(), "grid", "chave-teste", { method: "POST", body: JSON.stringify({ market: "BTC" }) });
    expect(res.status).toBe(400);
  });
});

describe("histórico", () => {
  it("limita os preços a 24 h e zera ao trocar de par", () => {
    const s = defaultState();
    for (let i = 0; i < MAX_PRICES + 10; i++) pushPrice(s, "BTC", 100 + i, i);
    expect(s.prices!.points).toHaveLength(MAX_PRICES);
    expect(s.prices!.points[0][1]).toBe(110);
    pushPrice(s, "ETH", 3000, 999);
    expect(s.prices).toEqual({ market: "ETH", points: [[999, 3000]] });
  });

  it("grava patrimônio no máximo uma vez por hora, salvo forçado", () => {
    const s = defaultState();
    pushEquity(s, 1000, false, 0);
    pushEquity(s, 1001, false, 60_000);
    pushEquity(s, 1002, true, 120_000);
    pushEquity(s, 1003, false, 3_800_000);
    expect(s.equity!.map((p) => p[1])).toEqual([1000, 1002, 1003]);
  });
});

describe("pares", () => {
  const limits = { allowedMarkets: ["*"] } as RiskLimits;
  it("'*' libera qualquer mercado; lista explícita restringe", () => {
    expect(marketAllowed(limits, "doge")).toBe(true);
    expect(marketAllowed({ allowedMarkets: ["BTC"] } as RiskLimits, "ETH")).toBe(false);
  });

  it("calcula a margem mínima como o Walt", () => {
    const btc = { contractId: 1, name: "BTC-USDC", priceDecimals: 1, minSizeBase: 0.00007, minSizeQuote: 1, maxSizeQuote: 25000, maxLeverage: 50, takerFeePct: 0.0009, priceSlippage: 0.01 };
    expect(minMargin(btc, 84276.5, 3)).toBeCloseTo(1.99, 2);
    expect(minMargin({ ...btc, minSizeBase: 0.000001 }, 84276.5, 3)).toBe(1); // piso de min_size_quote
  });
});
