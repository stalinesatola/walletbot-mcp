// Adaptador entre o bot e as tools do Walt MCP.
// Os nomes/argumentos reais das tools só são conhecidos depois do OAuth (tools/list),
// então o bot propõe um mapeamento automático e o dono confirma/ajusta com /map.
import { McpClient, resultData, type McpTool } from "./mcp";

export type Role = "price" | "account" | "open" | "close";
export const ROLES: Role[] = ["price", "account", "open", "close"];

export interface RoleBinding {
  tool: string;
  // valores podem conter {market} {sizeUsd} {qty} {leverage} {price}
  args: Record<string, unknown>;
}

export interface ToolMap {
  bindings: Partial<Record<Role, RoleBinding>>;
  confirmed: boolean; // live só roda com mapeamento confirmado pelo dono
}

export interface Placeholders {
  market: string;
  sizeUsd?: number;
  qty?: number;
  leverage?: number;
  price?: number;
}

const NAME_PATTERNS: Record<Role, { include: RegExp; exclude?: RegExp }> = {
  price: { include: /price|ticker|mid|quote|market_?data|markets?$/i, exclude: /order|place|open|close|history/i },
  account: { include: /account|balance|portfolio|equity|margin_?summary|wallet|positions?/i, exclude: /order|place|close/i },
  open: { include: /place|open|create_?order|market_?order|order|trade/i, exclude: /cancel|close|list|get|history|status/i },
  close: { include: /close|reduce/i, exclude: /list|get|history/i },
};

/** Propõe um mapeamento a partir de tools/list. */
export function proposeMap(tools: McpTool[]): ToolMap {
  const bindings: ToolMap["bindings"] = {};
  for (const role of ROLES) {
    const { include, exclude } = NAME_PATTERNS[role];
    const tool = tools.find((t) => include.test(t.name) && !(exclude && exclude.test(t.name)));
    if (tool) bindings[role] = { tool: tool.name, args: guessArgs(role, tool) };
  }
  return { bindings, confirmed: false };
}

const KEY_GUESSES: Array<[RegExp, (role: Role) => unknown]> = [
  [/^(market|symbol|coin|asset|ticker|pair|instrument)s?$/i, () => "{market}"],
  [/^(size_?usd|notional|usd_?size|amount_?usd|value_?usd|usd)$/i, () => "{sizeUsd}"],
  [/^(size|qty|quantity|amount|sz)$/i, (r) => (r === "close" ? "{qty}" : "{sizeUsd}")],
  [/^leverage$/i, () => "{leverage}"],
  [/^(reduce_?only)$/i, (r) => r === "close"],
  [/^(is_?long|is_?buy)$/i, (r) => r === "open"],
  [/^(type|order_?type)$/i, () => "market"],
];

function guessArgs(role: Role, tool: McpTool): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = tool.inputSchema?.properties ?? {};
  for (const [key, schema] of Object.entries(props)) {
    if (/^(side|direction)$/i.test(key)) {
      const want = role === "open" ? /long|buy/i : /short|sell/i;
      const option = (schema.enum ?? []).find((e) => typeof e === "string" && want.test(e));
      args[key] = option ?? (role === "open" ? "long" : "short");
      continue;
    }
    const guess = KEY_GUESSES.find(([re]) => re.test(key));
    if (guess) args[key] = guess[1](role);
  }
  return args;
}

export function fillArgs(template: Record<string, unknown>, p: Placeholders): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) out[k] = fillValue(v, p);
  return out;
}

function fillValue(v: unknown, p: Placeholders): unknown {
  if (typeof v === "string") {
    const exact = v.match(/^\{(\w+)\}$/);
    if (exact) return (p as unknown as Record<string, unknown>)[exact[1]] ?? v;
    return v.replace(/\{(\w+)\}/g, (m, k) => String((p as unknown as Record<string, unknown>)[k] ?? m));
  }
  if (Array.isArray(v)) return v.map((x) => fillValue(x, p));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillValue(x, p)]));
  return v;
}

const PRICE_KEYS = ["markPrice", "mark_price", "markPx", "midPrice", "mid_price", "mid", "price", "lastPrice", "last_price", "last", "oraclePrice"];
const EQUITY_KEYS = ["equity", "accountValue", "account_value", "totalEquity", "total_equity", "balance", "totalBalance", "availableBalance", "available_balance", "withdrawable"];
const MARKET_KEYS = ["market", "symbol", "coin", "asset", "ticker", "name"];

/** Procura recursivamente o primeiro número em uma das chaves (na ordem de preferência). */
export function findNumber(data: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const n = findKey(data, key, 0);
    if (n !== undefined) return n;
  }
  return undefined;
}

function findKey(data: unknown, key: string, depth: number): number | undefined {
  if (depth > 6 || data === null || typeof data !== "object") return undefined;
  if (!Array.isArray(data) && key in data) {
    const n = toNumber((data as Record<string, unknown>)[key]);
    if (n !== undefined) return n;
  }
  for (const v of Object.values(data)) {
    const n = findKey(v, key, depth + 1);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Preço de um mercado: se o resultado lista vários mercados, escolhe o objeto do mercado pedido. */
export function findMarketPrice(data: unknown, market: string): number | undefined {
  const target = market.toUpperCase();
  const matches = (s: unknown) =>
    typeof s === "string" && s.toUpperCase().replace(/[-_/]?(USDT?|USDC|PERP)$/g, "") === target;
  const scoped = findObject(data, (o) => MARKET_KEYS.some((k) => matches(o[k])), 0);
  if (scoped) return findNumber(scoped, PRICE_KEYS);
  // mapa { BTC: "65000.1", ... }
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const entry = Object.entries(data).find(([k]) => matches(k));
    if (entry) return toNumber(entry[1]) ?? findNumber(entry[1], PRICE_KEYS);
  }
  return findNumber(data, PRICE_KEYS);
}

function findObject(
  data: unknown,
  pred: (o: Record<string, unknown>) => boolean,
  depth: number,
): Record<string, unknown> | undefined {
  if (depth > 6 || data === null || typeof data !== "object") return undefined;
  if (!Array.isArray(data) && pred(data as Record<string, unknown>)) return data as Record<string, unknown>;
  for (const v of Object.values(data)) {
    const o = findObject(v, pred, depth + 1);
    if (o) return o;
  }
  return undefined;
}

function toNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export class Walt {
  constructor(
    private client: McpClient,
    private map: ToolMap,
  ) {}

  has(role: Role): boolean {
    return !!this.map.bindings[role];
  }

  async call(role: Role, p: Placeholders): Promise<unknown> {
    const binding = this.map.bindings[role];
    if (!binding) throw new Error(`nenhuma tool mapeada para "${role}" — use /map`);
    const result = await this.client.callTool(binding.tool, fillArgs(binding.args, p));
    const data = resultData(result);
    if (result.isError) throw new Error(`${binding.tool}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    return data;
  }

  async price(market: string): Promise<number> {
    const price = findMarketPrice(await this.call("price", { market }), market);
    if (!price) throw new Error(`não achei o preço de ${market} na resposta da tool`);
    return price;
  }

  async equity(market: string): Promise<number> {
    const eq = findNumber(await this.call("account", { market }), EQUITY_KEYS);
    if (eq === undefined) throw new Error("não achei o patrimônio na resposta da tool de conta");
    return eq;
  }

  async openLong(market: string, sizeUsd: number, leverage: number, price: number): Promise<{ qty: number; price: number }> {
    const qty = sizeUsd / price;
    const data = await this.call("open", { market, sizeUsd: round(sizeUsd, 2), qty: round(qty, 6), leverage, price });
    const fill = findNumber(data, ["avgPrice", "avg_price", "avgPx", "fillPrice", "fill_price", "price"]) ?? price;
    return { qty: sizeUsd / fill, price: fill };
  }

  async reduce(market: string, qty: number, price: number): Promise<{ price: number }> {
    const data = await this.call("close", { market, qty: round(qty, 6), sizeUsd: round(qty * price, 2), price });
    return { price: findNumber(data, ["avgPrice", "avg_price", "avgPx", "fillPrice", "fill_price", "price"]) ?? price };
  }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.floor(n * f) / f;
}
