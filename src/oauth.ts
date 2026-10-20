// OAuth 2.1 (cliente público + PKCE + registro dinâmico) contra o servidor de autorização do Walt.
import type { Env } from "./env";

const SCOPE = "perps.trade perps.readonly";
// O Walt só aceita redirect para localhost/127.0.0.1 (clientes locais). No Worker o navegador
// cai numa página que não carrega; o dono copia essa URL e envia com /code.
// Com `wrangler dev` na porta 8787 o callback funciona direto em /oauth/callback.
export const REDIRECT_URI = "http://localhost:8787/oauth/callback";

interface AuthServerMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface StoredClient {
  client_id: string;
  redirect_uri: string;
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope?: string;
}

const K_CLIENT = "oauth:client";
const K_TOKENS = "oauth:tokens";
const pendingKey = (state: string) => `oauth:pending:${state}`;

async function metadata(env: Env): Promise<AuthServerMeta> {
  // RFC 8414: issuer com path → /.well-known/oauth-authorization-server/<path>
  const issuer = new URL(env.WALT_AUTH_ISSUER);
  const url = `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`metadata OAuth indisponível (HTTP ${res.status})`);
  return (await res.json()) as AuthServerMeta;
}

async function ensureClient(env: Env, meta: AuthServerMeta, redirectUri: string): Promise<StoredClient> {
  const existing = await env.STATE.get<StoredClient>(K_CLIENT, "json");
  if (existing && existing.redirect_uri === redirectUri) return existing;
  if (!meta.registration_endpoint) throw new Error("servidor OAuth não suporta registro dinâmico");
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "walletbot-mcp (Telegram auto trade)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    }),
  });
  if (!res.ok) throw new Error(`registro OAuth falhou (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { client_id: string };
  const client = { client_id: body.client_id, redirect_uri: redirectUri };
  await env.STATE.put(K_CLIENT, JSON.stringify(client));
  return client;
}

/** Gera a URL de autorização que o dono abre no navegador. */
export async function startAuthorization(env: Env): Promise<string> {
  const meta = await metadata(env);
  const client = await ensureClient(env, meta, REDIRECT_URI);
  const state = randomString(24);
  const verifier = randomString(48);
  await env.STATE.put(pendingKey(state), verifier, { expirationTtl: 900 });
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", client.redirect_uri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", env.WALT_MCP_URL);
  return url.toString();
}

export async function handleCallback(env: Env, params: URLSearchParams): Promise<void> {
  const error = params.get("error");
  if (error) throw new Error(`autorização negada: ${error} ${params.get("error_description") ?? ""}`);
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  const verifier = state && (await env.STATE.get(pendingKey(state)));
  if (!verifier || !code) throw new Error("state inválido ou expirado — rode /connect de novo");
  await env.STATE.delete(pendingKey(state));
  const client = await env.STATE.get<StoredClient>(K_CLIENT, "json");
  if (!client) throw new Error("cliente OAuth não registrado");
  const meta = await metadata(env);
  await tokenRequest(env, meta, {
    grant_type: "authorization_code",
    code,
    redirect_uri: client.redirect_uri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: env.WALT_MCP_URL,
  });
}

/** Aceita a URL completa do redirect (ou só a query string) colada pelo dono. */
export function callbackParams(input: string): URLSearchParams {
  const text = input.trim();
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  return new URLSearchParams(query.split("#")[0]);
}

/** Devolve um access token válido (renovando se faltar < 2 min), ou null se não conectado. */
export async function getAccessToken(env: Env): Promise<string | null> {
  const tokens = await env.STATE.get<StoredTokens>(K_TOKENS, "json");
  if (!tokens) return null;
  if (!tokens.expires_at || tokens.expires_at - Date.now() > 120_000) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  const client = await env.STATE.get<StoredClient>(K_CLIENT, "json");
  if (!client) return null;
  const meta = await metadata(env);
  const fresh = await tokenRequest(env, meta, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
    resource: env.WALT_MCP_URL,
  });
  return fresh.access_token;
}

export async function disconnect(env: Env): Promise<void> {
  await env.STATE.delete(K_TOKENS);
}

async function tokenRequest(env: Env, meta: AuthServerMeta, form: Record<string, string>): Promise<StoredTokens> {
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`token OAuth falhou (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const previous = await env.STATE.get<StoredTokens>(K_TOKENS, "json");
  const tokens: StoredTokens = {
    access_token: body.access_token,
    // alguns servidores não rotacionam o refresh token
    refresh_token: body.refresh_token ?? previous?.refresh_token,
    expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    scope: body.scope,
  };
  await env.STATE.put(K_TOKENS, JSON.stringify(tokens));
  return tokens;
}

function randomString(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
