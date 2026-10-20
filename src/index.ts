import { tick } from "./bot";
import { handleApi } from "./api";
import { handleUpdate } from "./commands";
import type { Env } from "./env";
import { handleCallback } from "./oauth";
import { loadTools } from "./state";
import { COMMANDS, notifyOwner, tg, timingSafeEqual, type TgUpdate } from "./telegram";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/telegram") {
      const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("forbidden", { status: 403 });
      const update = (await req.json()) as TgUpdate;
      // responde 200 na hora para o Telegram não reenviar; processa em segundo plano
      ctx.waitUntil(handleUpdate(env, update));
      return new Response("ok");
    }

    if (url.pathname.startsWith("/api/")) return handleApi(req, env, ctx);

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
      // Com o Telegram Serverless ligado o webhook é do tgcloud (que encaminha para /api/telegram);
      // só registra o webhook direto no Worker quando não há Mini App configurada.
      const webhook = env.MINIAPP_URL
        ? "gerenciado pelo Telegram Serverless"
        : await tg(env, "setWebhook", {
            url: `${url.origin}/telegram`,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message"],
            drop_pending_updates: true,
          });
      const commands = await tg(env, "setMyCommands", {
        commands: COMMANDS.map(([command, description]) => ({ command, description })),
      });
      const menu = env.MINIAPP_URL
        ? await tg(env, "setChatMenuButton", {
            menu_button: { type: "web_app", text: "Painel", web_app: { url: env.MINIAPP_URL } },
          })
        : "sem MINIAPP_URL";
      return Response.json({ webhook, commands, menu });
    }

    // tools/list completo salvo pelo último /tools (protegido pelo mesmo segredo do webhook)
    if (req.method === "GET" && url.pathname === "/tools.json") {
      const secret = url.searchParams.get("secret") ?? "";
      if (!env.TELEGRAM_WEBHOOK_SECRET || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
        return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify((await loadTools(env)) ?? [], null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return new Response("walletbot-mcp ok");
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // sem lock no KV: o plano grátis tem 1000 escritas/dia e o tick leva segundos (cron de 5 min)
        await notifyOwner(env, await tick(env));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

function html(title: string, body: string, status = 200): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(body)}</p>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
