import { describe, expect, it } from "vitest";
import { readResponse } from "../src/mcp";
import { fillArgs, findMarketPrice, findNumber, proposeMap } from "../src/walt";

describe("walt adapter", () => {
  it("propõe mapeamento e argumentos a partir do schema", () => {
    const map = proposeMap([
      { name: "get_account", inputSchema: { properties: {} } },
      { name: "get_market_price", inputSchema: { properties: { symbol: {} } } },
      {
        name: "place_order",
        inputSchema: { properties: { coin: {}, side: { enum: ["LONG", "SHORT"] }, size_usd: {}, leverage: {} } },
      },
      { name: "close_position", inputSchema: { properties: { coin: {}, size: {} } } },
      { name: "cancel_order", inputSchema: { properties: { id: {} } } },
    ]);
    expect(map.confirmed).toBe(false);
    expect(map.bindings.price).toEqual({ tool: "get_market_price", args: { symbol: "{market}" } });
    expect(map.bindings.account?.tool).toBe("get_account");
    expect(map.bindings.open).toEqual({
      tool: "place_order",
      args: { coin: "{market}", side: "LONG", size_usd: "{sizeUsd}", leverage: "{leverage}" },
    });
    expect(map.bindings.close).toEqual({ tool: "close_position", args: { coin: "{market}", size: "{qty}" } });
  });

  it("preenche placeholders mantendo o tipo", () => {
    expect(fillArgs({ coin: "{market}", sz: "{qty}", note: "grid {market}", reduce: true }, { market: "BTC", qty: 0.5 })).toEqual({
      coin: "BTC",
      sz: 0.5,
      note: "grid BTC",
      reduce: true,
    });
  });

  it("acha preço do mercado certo em uma lista", () => {
    const data = { markets: [{ symbol: "ETH-PERP", markPrice: "3000" }, { symbol: "BTC-PERP", markPrice: "65000.5" }] };
    expect(findMarketPrice(data, "BTC")).toBe(65000.5);
    expect(findMarketPrice({ BTC: "64000", ETH: "3000" }, "ETH")).toBe(3000);
    expect(findNumber({ summary: { accountValue: "1234.5" } }, ["equity", "accountValue"])).toBe(1234.5);
  });

  it("lê resposta JSON-RPC via SSE", async () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    const res = new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    expect(await readResponse(res, 2)).toMatchObject({ result: { ok: true } });
  });
});
