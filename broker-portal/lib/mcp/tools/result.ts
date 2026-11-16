/**
 * Shared pieces of the Keepr MCP tools (BACKLOG-4244): tool results, argument checks and the
 * mapping from database outcomes to the fixed error texts in ./text.ts.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import type { AccessArgs, DataToolResult } from '@/lib/mcp/oauth/rpc';
import { TOOL_MESSAGES } from './text';

/** Largest result text sent to an AI app; the database caps its own answer below this. */
export const MAX_RESULT_CHARS = 100_000;

/** The digest the route puts in authInfo.extra: bytea text form of a 32-byte HMAC. */
const AT_DIGEST = /^\\x[0-9a-f]{64}$/;

export function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function toolResult(result: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify(result);
  if (text.length > MAX_RESULT_CHARS) return toolError(TOOL_MESSAGES.too_large);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

/** Database outcome -> what the AI app is shown. Anything not known is "could not answer". */
export function fromDatabase(res: DataToolResult): CallToolResult {
  if (res.kind === 'ok') return toolResult(res.result);
  if (res.kind === 'error') {
    switch (res.error) {
      case 'not_connected':
      case 'disabled':
      case 'rate_limited':
      case 'not_entitled':
      case 'invalid_input':
      case 'not_found':
      case 'too_large':
        return toolError(TOOL_MESSAGES[res.error]);
      default:
        return toolError(TOOL_MESSAGES.unavailable);
    }
  }
  return toolError(TOOL_MESSAGES.unavailable);
}

/** Config and digest for a database call, or null when either is missing or malformed. */
export function accessFor(atDigest: unknown): { cfg: Extract<ReturnType<typeof oauthConfig>, { state: 'ok' }>; access: AccessArgs } | null {
  const cfg = oauthConfig();
  if (cfg.state !== 'ok' || typeof atDigest !== 'string' || !AT_DIGEST.test(atDigest)) return null;
  return { cfg, access: { secret: cfg.secret, atDigest, resource: cfg.resource } };
}

// ---------------------------------------------------------------------------
// Arguments. A call with `arguments` omitted is {}. Unknown keys or wrong types are invalid_input,
// and no database call is made.
// ---------------------------------------------------------------------------

export class InvalidInput extends Error {
  constructor() {
    super('invalid_input');
    this.name = 'InvalidInput';
  }
}

export function argsObject(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidInput();
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw new InvalidInput();
  }
  return o;
}

export function optString(o: Record<string, unknown>, k: string, test: (_s: string) => boolean): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !test(v)) throw new InvalidInput();
  return v;
}

export function optInteger(o: Record<string, unknown>, k: string, min: number, max: number): number | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new InvalidInput();
  return v;
}

export function optBoolean(o: Record<string, unknown>, k: string): boolean | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw new InvalidInput();
  return v;
}

export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
