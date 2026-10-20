import type { Env } from "../src/env";

export function memoryKV(): KVNamespace {
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

export const env = (): Env => ({
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
  API_SECRET: "chave-teste",
});
