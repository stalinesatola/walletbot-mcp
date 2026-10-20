// Adaptador para as tools do Walt Perps (ver perps_guide): leituras diretas e escritas
// sempre em duas etapas — perps_prepare_* (preview + confirmationToken) → perps_execute_operation.
// Nunca repete um execute automaticamente (o guia avisa que isso pode disparar duas vezes).
import { McpClient, resultData, type McpTool } from "./mcp";
import type { ContractInfo } from "./strategy/grid";

export class WaltError extends Error {}

interface Preview {
  ok: boolean;
  confirmationToken: string | null;
  risk?: { checks?: Array<{ name?: string; ok?: boolean; message?: string }> };
  warnings?: unknown[];
}

export interface WaltPosition {
  contractId: number;
  avgEntryPrice?: number;
  valueBase?: number;
  marginQuote?: number;
  liquidationPrice?: number;
  raw: Record<string, unknown>;
}

export class Walt {
  constructor(private client: McpClient) {}

  listTools(): Promise<McpTool[]> {
    return this.client.listTools();
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.client.callTool(tool, args);
    const data = resultData(result);
    if (result.isError) throw new WaltError(`${tool}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    return data;
  }

  async contracts(): Promise<ContractInfo[]> {
    const data = (await this.call("perps_list_contracts")) as { contracts?: Array<Record<string, unknown>> };
    return (data.contracts ?? []).filter((c) => c.is_active !== false).map(parseContract);
  }

  /** Preço (fechamento de 1m). O guia não diz se marketId é o id numérico ou o nome — tenta os dois. */
  async rate(contract: ContractInfo): Promise<number> {
    let lastErr: unknown;
    for (const marketId of [contract.contractId, contract.name]) {
      try {
        const data = (await this.call("perps_latest_rate", { marketId })) as { rate?: unknown };
        const rate = Number(data?.rate);
        if (Number.isFinite(rate) && rate > 0) return rate;
        lastErr = new WaltError(`perps_latest_rate sem rate: ${JSON.stringify(data)}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async readiness(): Promise<{ ok: boolean; issues: Array<{ code: string; description?: string }> }> {
    const data = (await this.call("perps_readiness")) as { ok?: boolean; issues?: Array<{ code: string; description?: string }> };
    return { ok: !!data.ok, issues: data.issues ?? [] };
  }

  /** Saldo disponível em USDC. */
  async balanceUsd(): Promise<number> {
    const n = usdcBalance(await this.call("balance_get"));
    if (n === undefined) throw new WaltError("não achei o saldo USDC na resposta de balance_get");
    return n;
  }

  async openPosition(contractId: number): Promise<WaltPosition | null> {
    const data = await this.call("perps_list_positions", { contractId });
    return findOpenPosition(data, contractId);
  }

  async openLong(
    contract: ContractInfo,
    marginUsd: number,
    leverage: number,
    price: number,
    takeProfit: number,
    stopLoss: number,
  ): Promise<unknown> {
    const d = contract.priceDecimals;
    return this.prepareAndExecute("perps_prepare_order_place", {
      contractId: contract.contractId,
      side: "long",
      type: "market",
      leverage,
      amount: marginUsd.toFixed(2),
      price: price.toFixed(d),
      autoClose: {
        takeProfit: { priceQuote: takeProfit.toFixed(d) },
        stopLoss: { priceQuote: stopLoss.toFixed(d) },
      },
    });
  }

  async closePosition(contractId: number): Promise<unknown> {
    return this.prepareAndExecute("perps_prepare_position_close", { contractId });
  }

  async createAccount(): Promise<unknown> {
    return this.prepareAndExecute("perps_prepare_account_create", {});
  }

  async preview(tool: string, args: Record<string, unknown>): Promise<Preview> {
    return (await this.call(tool, args)) as Preview;
  }

  private async prepareAndExecute(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const preview = await this.preview(tool, args);
    if (!preview.ok || !preview.confirmationToken) throw new WaltError(`preview recusado: ${previewReason(preview)}`);
    return this.call("perps_execute_operation", { confirmationToken: preview.confirmationToken });
  }
}

export function parseContract(c: Record<string, unknown>): ContractInfo {
  const n = (k: string) => Number(c[k]);
  return {
    contractId: n("contract_id"),
    name: String(c.contract_name),
    priceDecimals: n("price_decimals"),
    minSizeBase: n("min_size_base"),
    minSizeQuote: n("min_size_quote"),
    maxSizeQuote: n("max_size_quote"),
    maxLeverage: n("max_leverage"),
    takerFeePct: n("taker_fee_pct"),
    priceSlippage: n("price_slippage"),
  };
}

export function findContract(contracts: ContractInfo[], market: string): ContractInfo | undefined {
  const m = market.toUpperCase();
  return contracts.find((c) => c.name.toUpperCase() === m || c.name.toUpperCase() === `${m}-USDC`);
}

export function previewReason(p: Preview): string {
  const failing = (p.risk?.checks ?? []).filter((c) => c.ok === false);
  if (failing.length) return failing.map((c) => `${c.name ?? "check"}: ${c.message ?? "falhou"}`).join("; ");
  return JSON.stringify(p).slice(0, 300);
}

const CLOSED = /closed|liquidated|cancel/i;

export function findOpenPosition(data: unknown, contractId: number): WaltPosition | null {
  const list = Array.isArray(data)
    ? data
    : ((data as Record<string, unknown>)?.positions ?? (data as Record<string, unknown>)?.items ?? []);
  for (const p of list as Array<Record<string, unknown>>) {
    const id = Number(p.contract_id ?? p.contractId);
    if (id !== contractId) continue;
    if (typeof p.status === "string" && CLOSED.test(p.status)) continue;
    const size = Number(p.value_base ?? p.size_base ?? p.size);
    if (Number.isFinite(size) && size === 0) continue;
    const num = (k: string) => (p[k] === undefined ? undefined : Number(p[k]));
    return {
      contractId: id,
      avgEntryPrice: num("avg_entry_price"),
      valueBase: num("value_base"),
      marginQuote: num("margin_quote"),
      liquidationPrice: num("liquidation_price"),
      raw: p,
    };
  }
  return null;
}

/** Procura o saldo USDC disponível: lista de balances {asset/currency, available/amount} ou campos diretos. */
export function usdcBalance(data: unknown): number | undefined {
  const isUsdc = (o: Record<string, unknown>) =>
    ["asset", "currency", "symbol", "quote_asset", "code"].some((k) => typeof o[k] === "string" && /^USDC?$/i.test(o[k] as string));
  const amountKeys = ["available", "available_amount", "availableBalance", "available_balance", "free", "balance", "amount", "total"];
  const visit = (v: unknown, depth: number): number | undefined => {
    if (depth > 5 || !v || typeof v !== "object") return undefined;
    if (!Array.isArray(v) && isUsdc(v as Record<string, unknown>)) {
      for (const k of amountKeys) {
        const n = Number((v as Record<string, unknown>)[k]);
        if (Number.isFinite(n)) return n;
      }
    }
    for (const x of Object.values(v)) {
      const n = visit(x, depth + 1);
      if (n !== undefined) return n;
    }
    return undefined;
  };
  return visit(data, 0);
}
