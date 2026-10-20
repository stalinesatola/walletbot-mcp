import { tick } from "./bot";
import { handleCommand } from "./commands";
import type { Env } from "./env";
import { handleCallback } from "./oauth";
import { acquireLock, releaseLock } from "./state";
import { COMMANDS, notifyOwner, send, tg, timingSafeEqual, type TgUpdate } from "./telegram";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/telegram") {
      const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("forbidden", { status: 403 });
      const update = (await req.json()) as TgUpdate;
      // responde 200 na hora para o Telegram não reenviar; processa em segundo plano
      ctx.waitUntil(onMessage(env, update));
      return new Response("ok");
    }

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      try {
        await handleCallback(env, url.searchParams);
        ctx.waitUntil(
          notifyOwner(env, ["✅ Walt conectado! Use /tools para ver as tools e revisar o mapeamento."]),
        );
        return html("Walt conectado ✅", "Pode fechar esta página e voltar ao Telegram.");
      } catch (e) {
        return html("Falha na conexão", (e as Error).message, 400);
      }
    }

    if (req.method === "GET" && url.pathname === "/setup") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("forbidden", { status: 403 });
      const webhook = await tg(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      const commands = await tg(env, "setMyCommands", {
        commands: COMMANDS.map(([command, description]) => ({ command, description })),
      });
      return Response.json({ webhook, commands });
    }

    return new Response("walletbot-mcp ok");
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        if (!(await acquireLock(env))) return;
        try {
          await notifyOwner(env, await tick(env));
        } finally {
          await releaseLock(env);
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

async function onMessage(env: Env, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = String(msg.chat.id);
  if (!env.OWNER_CHAT_ID) {
    await send(env, chatId, `Seu chat id é ${chatId}. Configure o secret OWNER_CHAT_ID com esse valor.`);
    return;
  }
  if (chatId !== env.OWNER_CHAT_ID) return; // só o dono controla o bot
  let reply: string;
  try {
    reply = await handleCommand(env, msg.text);
  } catch (e) {
    reply = `❌ ${(e as Error).message}`;
  }
  await send(env, chatId, reply);
}

function html(title: string, body: string, status = 200): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(body)}</p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
