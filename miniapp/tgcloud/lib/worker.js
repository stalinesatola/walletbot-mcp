// Ponte com o Worker da Cloudflare, que roda o trading (cron, Walt, KV).
import { db, fetch, EndpointError } from 'sdk';
import { eq } from 'sdk/db';
import { config } from '../schema.js';

// URL pública do Worker (não é segredo; a API exige X-Api-Key).
export const WORKER_URL = 'https://walletbot-mcp.satola-staline.workers.dev';

export async function getConfig(key) {
  const row = await db.select().from(config).where(eq(config.key, key)).get();
  return row ? row.value : null;
}

export async function setConfig(key, value) {
  await db
    .insert(config)
    .values({ key, value })
    .onConflictDoUpdate({ target: config.key, set: { value } })
    .run();
}

/** Chama a API do Worker. `apiKey` opcional (usado no /link antes de gravar a chave). */
export async function workerCall(path, { method = 'GET', body, apiKey } = {}) {
  const key = apiKey ?? (await getConfig('api_key'));
  if (!key) throw new EndpointError('Bot ainda não vinculado ao Worker — envie /link <API_SECRET> no chat do bot.', { code: 'NOT_LINKED' });
  const res = await fetch(`${WORKER_URL}/api/${path}`, {
    method,
    headers: { 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) {
    throw new EndpointError(String(data.error ?? `Worker respondeu HTTP ${res.status}`), { code: 'WORKER', status: res.status });
  }
  return data;
}

/** Só o dono (quem fez o /link) usa a Mini App. */
export async function assertOwner(ctx) {
  const owner = await getConfig('owner_id');
  if (!owner || String(ctx.initData?.user?.id) !== owner) {
    throw new EndpointError('Acesso restrito ao dono do bot.', { code: 'FORBIDDEN' });
  }
}
