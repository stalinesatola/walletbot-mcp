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

/** Alertas automáticos: vão para ALERT_CHAT_ID (canal) se configurado; se o envio falhar, caem no dono. */
export async function notifyOwner(env: Env, msgs: string[]): Promise<void> {
  if (msgs.length === 0) return;
  const text = msgs.join("\n");
  if (env.ALERT_CHAT_ID) {
    const res = (await tg(env, "sendMessage", { chat_id: env.ALERT_CHAT_ID, text, disable_web_page_preview: true })) as {
      ok?: boolean;
      description?: string;
    };
    if (res.ok) return;
    if (env.OWNER_CHAT_ID)
      await send(env, env.OWNER_CHAT_ID, `⚠️ Não consegui postar no canal ${env.ALERT_CHAT_ID} (${res.description ?? "erro"}). Alerta:\n${text}`);
    return;
  }
  if (env.OWNER_CHAT_ID) await send(env, env.OWNER_CHAT_ID, text);
}

export const COMMANDS: Array<[string, string]> = [
  ["help", "Ajuda"],
  ["status", "Estado do bot, grid e PnL"],
  ["connect", "Conectar a conta Walt (OAuth)"],
  ["code", "Concluir o /connect: /code <endereço localhost>"],
  ["conta", "Checar/criar a conta Perps do agente"],
  ["saldo", "Saldo USDC no Walt"],
  ["tools", "Listar tools do Walt"],
  ["grid", "Configurar: /grid BTC 100000 110000 10 5 3"],
  ["run", "Iniciar o grid"],
  ["stop", "Parar o grid (posição fica com TP/SL)"],
  ["closeall", "Fechar a posição do grid e parar"],
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
