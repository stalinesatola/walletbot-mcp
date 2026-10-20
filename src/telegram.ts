import type { Env } from "./env";

export interface TgUpdate {
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
}

export async function tg(env: Env, method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function send(env: Env, chatId: string | number, text: string): Promise<void> {
  // limite do Telegram: 4096 caracteres por mensagem
  for (let i = 0; i < text.length; i += 4000) {
    await tg(env, "sendMessage", { chat_id: chatId, text: text.slice(i, i + 4000), disable_web_page_preview: true });
  }
}

export async function notifyOwner(env: Env, msgs: string[]): Promise<void> {
  if (!env.OWNER_CHAT_ID || msgs.length === 0) return;
  await send(env, env.OWNER_CHAT_ID, msgs.join("\n"));
}

export const COMMANDS: Array<[string, string]> = [
  ["help", "Ajuda"],
  ["status", "Estado do bot, grid e PnL"],
  ["connect", "Conectar a conta Walt (OAuth)"],
  ["code", "Concluir o /connect: /code <endereço localhost>"],
  ["tools", "Listar tools do Walt e o mapeamento"],
  ["grid", "Configurar grid: /grid BTC 60000 70000 10 100 [alav]"],
  ["run", "Iniciar o grid"],
  ["stop", "Parar o grid (mantém posições)"],
  ["closeall", "Fechar posições do grid e parar"],
  ["mode", "paper | live CONFIRMO"],
  ["risk", "Ver travas de risco"],
  ["resume", "Retomar após pausa automática"],
];

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
