// Preço de referência público (Hyperliquid) — usado no modo paper quando o Walt
// ainda não está conectado ou não há tool de preço mapeada.
export async function publicMid(market: string): Promise<number> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "allMids" }),
  });
  if (!res.ok) throw new Error(`preço público indisponível (HTTP ${res.status})`);
  const mids = (await res.json()) as Record<string, string>;
  const price = Number(mids[market.toUpperCase()]);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`mercado ${market} sem preço público`);
  return price;
}
