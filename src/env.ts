export interface Env {
  STATE: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_CHAT_ID: string;
  ALERT_CHAT_ID?: string;
  WALT_MCP_URL: string;
  WALT_AUTH_ISSUER: string;
  MAX_LEVERAGE: string;
  MAX_ORDER_PCT: string;
  MAX_TOTAL_EXPOSURE_PCT: string;
  MAX_DAILY_LOSS_PCT: string;
  STOP_LOSS_PCT: string;
  ALLOWED_MARKETS: string;
}

export interface RiskLimits {
  maxLeverage: number;
  maxOrderPct: number;
  maxTotalExposurePct: number;
  maxDailyLossPct: number;
  stopLossPct: number;
  allowedMarkets: string[];
}

export function riskLimits(env: Env): RiskLimits {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxLeverage: num(env.MAX_LEVERAGE, 3),
    maxOrderPct: num(env.MAX_ORDER_PCT, 5),
    maxTotalExposurePct: num(env.MAX_TOTAL_EXPOSURE_PCT, 50),
    maxDailyLossPct: num(env.MAX_DAILY_LOSS_PCT, 5),
    stopLossPct: num(env.STOP_LOSS_PCT, 5),
    allowedMarkets: (env.ALLOWED_MARKETS || "BTC,ETH,SOL")
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean),
  };
}
