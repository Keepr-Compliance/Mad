/**
 * get_status (BACKLOG-4237, BACKLOG-4238; outputSchema BACKLOG-4244).
 *
 * The answer comes from the database (mcp_get_status), keyed by the access
 * token digest the route computed. Node adds only the protocol and server
 * versions. Every refusal is a tool error with fixed text.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import { getStatusFor } from '@/lib/mcp/oauth/rpc';
import { TOOL_ANNOTATIONS } from './result';
import { STATUS_SHAPE, toJsonSchema } from './shapes';
import { TOOL_MESSAGES, TOOL_TEXT } from './text';

export const STATUS_TOOL_NAME = TOOL_TEXT.get_status.name;

export const STATUS_TOOL: Tool = {
  name: STATUS_TOOL_NAME,
  title: TOOL_TEXT.get_status.title,
  description: TOOL_TEXT.get_status.description,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: toJsonSchema(STATUS_SHAPE) as Tool['outputSchema'],
  annotations: TOOL_ANNOTATIONS,
};

/** Tool error texts (plan section m, M-S1..M-S4), from ./text. */
const STATUS_MESSAGES = TOOL_MESSAGES;

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
