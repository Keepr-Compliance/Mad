/**
 * get_status — the one MCP tool (BACKLOG-4237, BACKLOG-4238).
 *
 * The answer comes from the database (mcp_get_status), keyed by the access
 * token digest the route computed. Node adds only the protocol and server
 * versions. Every refusal is a tool error with fixed text.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import { getStatusFor } from '@/lib/mcp/oauth/rpc';

export const STATUS_TOOL_NAME = 'get_status';

export const STATUS_TOOL: Tool = {
  name: STATUS_TOOL_NAME,
  title: 'Keepr connection status',
  description: 'Confirms the Keepr connection works. Returns no account data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** Tool error texts (plan section m, M-S1..M-S4). */
const STATUS_MESSAGES = {
  not_connected: 'This connection was removed. Reconnect Keepr in your AI app.',
  disabled: 'Keepr AI access is turned off right now.',
  rate_limited: 'Too many requests. Try again in a minute.',
  unavailable: 'Keepr could not answer. Try again.',
} as const;

/** The digest the route puts in authInfo.extra: bytea text form of a 32-byte HMAC. */
const AT_DIGEST = /^\\x[0-9a-f]{64}$/;

function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export async function getStatus(atDigest: unknown, protocolVersion: string, serverVersion: string): Promise<CallToolResult> {
  const cfg = oauthConfig();
  if (cfg.state !== 'ok' || typeof atDigest !== 'string' || !AT_DIGEST.test(atDigest)) {
    return toolError(STATUS_MESSAGES.unavailable);
  }
  const res = await getStatusFor(cfg, { secret: cfg.secret, atDigest, resource: cfg.resource });
  if (res.kind === 'ok') {
    const status = { ...res.result, protocolVersion, serverVersion };
    return { content: [{ type: 'text', text: JSON.stringify(status) }], structuredContent: { ...status } };
  }
  if (res.kind === 'error') {
    if (res.error === 'not_connected') return toolError(STATUS_MESSAGES.not_connected);
    if (res.error === 'disabled') return toolError(STATUS_MESSAGES.disabled);
    if (res.error === 'rate_limited') return toolError(STATUS_MESSAGES.rate_limited);
  }
  return toolError(STATUS_MESSAGES.unavailable);
}
