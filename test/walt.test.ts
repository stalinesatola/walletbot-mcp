import { describe, expect, it } from "vitest";
import { readResponse } from "../src/mcp";
import { callbackParams } from "../src/oauth";
import { findContract, findOpenPosition, parseContract, previewReason, usdcBalance } from "../src/walt";

describe("adaptador Walt", () => {
  const contracts = [
    parseContract({ contract_id: 0, contract_name: "ETH-USDC", price_decimals: 2, min_size_base: "0.0020", min_size_quote: "1.0", max_size_quote: "25000.0", max_leverage: 50, taker_fee_pct: "0.0009", price_slippage: "0.01" }),
    parseContract({ contract_id: 1, contract_name: "BTC-USDC", price_decimals: 1, min_size_base: "0.00007", min_size_quote: "1.0", max_size_quote: "25000.0", max_leverage: 50, taker_fee_pct: "0.0009", price_slippage: "0.01" }),
  ];

  it("resolve mercado → contrato (id 0 é válido)", () => {
    expect(findContract(contracts, "eth")?.contractId).toBe(0);
    expect(findContract(contracts, "BTC")?.minSizeBase).toBe(0.00007);
    expect(findContract(contracts, "SOL")).toBeUndefined();
  });

  it("acha a posição aberta do contrato", () => {
    const data = { positions: [{ contract_id: 0, value_base: "0.01", avg_entry_price: "3000" }, { contract_id: 1, status: "closed", value_base: "0.001" }] };
    expect(findOpenPosition(data, 0)?.avgEntryPrice).toBe(3000);
    expect(findOpenPosition(data, 1)).toBeNull();
    expect(findOpenPosition({ positions: [] }, 0)).toBeNull();
  });

  it("lê saldo USDC", () => {
    expect(usdcBalance({ balances: [{ currency: "TON", available: "5" }, { currency: "USDC", available: "12.5" }] })).toBe(12.5);
    expect(usdcBalance({ asset: "USDC", amount: 3 })).toBe(3);
    expect(usdcBalance({ foo: 1 })).toBeUndefined();
  });

  it("explica preview recusado", () => {
    expect(previewReason({ ok: false, confirmationToken: null, risk: { checks: [{ name: "leverage", ok: false, message: "too high" }] } })).toBe(
      "leverage: too high",
    );
  });
});

describe("infra", () => {
  it("lê resposta JSON-RPC via SSE", async () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    const res = new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    expect(await readResponse(res, 2)).toMatchObject({ result: { ok: true } });
  });

  it("extrai code e state da URL localhost colada", () => {
    const p = callbackParams("http://localhost:8787/oauth/callback?code=abc&state=xyz");
    expect(p.get("code")).toBe("abc");
    expect(p.get("state")).toBe("xyz");
  });
});
