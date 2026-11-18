/**
 * The /api/mcp request body, read once by the route, and the answers for a refused request (BACKLOG-4263 PR-10).
 *
 * The route hands the parsed body to the SDK as `parsedBody`. The SDK then skips its own body read and with it its
 * size check (@modelcontextprotocol/server 2.4.0), so the size check is made here, with the SDK's reader, limit and
 * answer.
 */

import { isJsonContentType, readRequestBody } from '@modelcontextprotocol/server';
import { MCP_BATCH_LIMIT } from '@/lib/mcp/rateLimit';
import { TOOL_MESSAGES } from '@/lib/mcp/tools/text';

/** The SDK's body limit for this endpoint (lib/mcp/server.ts `maxRequestBodySize`). */
export const MCP_MAX_BODY_BYTES = 256 * 1024;

export type McpBody =
  /** Parsed JSON: hand `parsed` to the SDK. `ids` holds one entry per JSON-RPC request, in body order. */
  | { kind: 'parsed'; parsed: unknown; batch: boolean; ids: Array<string | number | null> }
  /** Not JSON, empty, or not a JSON content type: hand `request` to the SDK, which answers it as it does today. */
  | { kind: 'raw'; request: Request }
  | { kind: 'too_large' }
  | { kind: 'unreadable' };

/** A JSON-RPC request: a method and an id. Notifications (no id) and responses (no method) are not requests. */
function requestId(message: unknown): { request: false } | { request: true; id: string | number | null } {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return { request: false };
  const m = message as Record<string, unknown>;
  if (typeof m.method !== 'string' || !('id' in m) || m.id === undefined) return { request: false };
  return { request: true, id: typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null };
}

export async function readMcpBody(req: Request): Promise<McpBody> {
  if (!isJsonContentType(req.headers.get('content-type'))) return { kind: 'raw', request: req };
  let text: string;
  try {
    const read = await readRequestBody(req, MCP_MAX_BODY_BYTES);
    if (read.tooLarge) return { kind: 'too_large' };
    text = read.text;
  } catch {
    return { kind: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    // The body is consumed: the SDK gets the same text in a new request, with the same headers and abort signal.
    return { kind: 'raw', request: new Request(req.url, { method: 'POST', headers: req.headers, body: text, signal: req.signal }) };
  }
  const batch = Array.isArray(parsed);
  const ids: Array<string | number | null> = [];
  for (const message of batch ? (parsed as unknown[]) : [parsed]) {
    const r = requestId(message);
    if (r.request) ids.push(r.id);
  }
  return { kind: 'parsed', parsed, batch, ids };
}

const JSON_RPC_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } as const;

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status });
}

/** The SDK's answer to a body over the limit (its entry handler's 413, transcribed from SDK 2.4.0). */
export function mcpBodyTooLarge(): Response {
  return jsonRpcError(413, -32000, `Payload Too Large: Request body must not exceed ${MCP_MAX_BODY_BYTES} bytes`);
}

/** The SDK's answer to a body that cannot be read. */
export function mcpBodyUnreadable(): Response {
  return jsonRpcError(400, -32700, 'Parse error: the request body could not be read');
}

/** More than MCP_BATCH_LIMIT JSON-RPC requests in one POST: the SDK's batch answer, with this endpoint's limit. */
export function mcpBatchTooLarge(): Response {
  return jsonRpcError(400, -32600, `Invalid Request: Batch must not exceed ${MCP_BATCH_LIMIT} messages`);
}

/**
 * A request refused by a limit: HTTP 200 with a JSON-RPC error for each request, carrying that request's own id,
 * so a client delivers it to the pending call. A single object for a single request, an array for a batch.
 * A body with no request (notifications or responses only) gets 202 with no body, as the SDK answers it.
 */
export function mcpRateLimited(ids: ReadonlyArray<string | number | null>, batch: boolean): Response {
  if (ids.length === 0) return new Response(null, { status: 202 });
  const answers = ids.map((id) => ({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: TOOL_MESSAGES.rate_limited },
  }));
  return new Response(JSON.stringify(batch ? answers : answers[0]), { status: 200, headers: JSON_RPC_HEADERS });
}

/**
 * The response with `release` called once when its body ends: read to the end, cancelled, or failed. A response
 * with no body releases at once. The body is pumped as it arrives, so the release does not wait for a reader.
 */
export function releaseWhenDone(res: Response, release: () => void): Response {
  if (res.body === null) {
    release();
    return res;
  }
  const reader = res.body.getReader();
  const pump = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      release();
      controller.close();
    } catch (err) {
      release();
      try {
        controller.error(err);
      } catch {
        // the reader already cancelled the body
      }
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      void pump(controller);
    },
    cancel(reason) {
      release();
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
