// Cliente MCP mínimo (transporte Streamable HTTP) — stateless: cada invocação do Worker
// faz initialize → chamadas, porque Workers não mantêm conexão entre requisições.

const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, JsonSchema>; required?: string[] };
}

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export class McpAuthError extends Error {}

export class McpClient {
  private sessionId?: string;
  private nextId = 1;
  private initialized = false;

  constructor(
    private url: string,
    private token: string,
  ) {}

  async listTools(): Promise<McpTool[]> {
    await this.init();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const res = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools: McpTool[];
        nextCursor?: string;
      };
      tools.push(...(res.tools ?? []));
      cursor = res.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.init();
    return (await this.request("tools/call", { name, arguments: args })) as McpCallResult;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "walletbot-mcp", version: "0.1.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = true;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const msg = await readResponse(res, id);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  }

  private async post(body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.initialized) headers["MCP-Protocol-Version"] = PROTOCOL_VERSION;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 401 || res.status === 403) throw new McpAuthError(`MCP recusou o token (HTTP ${res.status})`);
    if (!res.ok && res.status !== 202) throw new Error(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const sid = res.headers.get("Mcp-Session-Id");
    if (sid) this.sessionId = sid;
    return res;
  }
}

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

/** Lê a resposta JSON-RPC, seja JSON simples ou um stream SSE. */
export async function readResponse(res: Response, id: number): Promise<RpcMessage> {
  const type = res.headers.get("Content-Type") ?? "";
  const text = await res.text();
  if (!type.includes("text/event-stream")) {
    const parsed = JSON.parse(text) as RpcMessage | RpcMessage[];
    const msgs = Array.isArray(parsed) ? parsed : [parsed];
    const found = msgs.find((m) => m.id === id);
    if (!found) throw new Error("MCP: resposta sem o id esperado");
    return found;
  }
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as RpcMessage;
      if (msg.id === id) return msg;
    } catch {
      // evento não-JSON: ignora
    }
  }
  throw new Error("MCP: stream SSE terminou sem resposta");
}

/** Extrai o payload útil de um resultado de tool (structuredContent ou texto JSON). */
export function resultData(result: McpCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = (result.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text!);
  const parsed = texts.map((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  });
  return parsed.length === 1 ? parsed[0] : parsed;
}

export function resultText(result: McpCallResult): string {
  const data = resultData(result);
  return typeof data === "string" ? data : JSON.stringify(data, null, 1);
}
