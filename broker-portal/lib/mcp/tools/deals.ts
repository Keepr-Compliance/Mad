/**
 * list_deals and get_deal (BACKLOG-4244). Read-only. The answer comes from the database
 * (mcp_list_deals, mcp_get_deal), keyed by the access token digest the route computed; the
 * database resolves the account and reads only that account's rows.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { getDealFor, listDealsFor } from '@/lib/mcp/oauth/rpc';
import {
  accessFor,
  argsObject,
  fromDatabase,
  InvalidInput,
  optInteger,
  optString,
  TOOL_ANNOTATIONS,
  toolError,
} from './result';
import { GET_DEAL_SHAPE, LIST_DEALS_SHAPE, toJsonSchema, UUID } from './shapes';
import { ARG_TEXT, TOOL_MESSAGES, TOOL_TEXT } from './text';

export const LIST_DEALS_TOOL: Tool = {
  name: TOOL_TEXT.list_deals.name,
  title: TOOL_TEXT.list_deals.title,
  description: TOOL_TEXT.list_deals.description,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'pending', 'closed'], description: ARG_TEXT.status },
      address_contains: { type: 'string', minLength: 2, maxLength: 100, description: ARG_TEXT.address_contains },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: ARG_TEXT.limit },
      cursor: { type: 'string', maxLength: 80, description: ARG_TEXT.cursor },
    },
    additionalProperties: false,
  },
  outputSchema: toJsonSchema(LIST_DEALS_SHAPE) as Tool['outputSchema'],
  annotations: TOOL_ANNOTATIONS,
};

export const GET_DEAL_TOOL: Tool = {
  name: TOOL_TEXT.get_deal.name,
  title: TOOL_TEXT.get_deal.title,
  description: TOOL_TEXT.get_deal.description,
  inputSchema: {
    type: 'object',
    properties: { deal_id: { type: 'string', format: 'uuid', description: ARG_TEXT.deal_id } },
    required: ['deal_id'],
    additionalProperties: false,
  },
  outputSchema: toJsonSchema(GET_DEAL_SHAPE) as Tool['outputSchema'],
  annotations: TOOL_ANNOTATIONS,
};

const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function listDeals(atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let status: string | null, addressContains: string | null, limit: number | null, cursor: string | null;
  try {
    const o = argsObject(rawArgs, ['status', 'address_contains', 'limit', 'cursor']);
    status = optString(o, 'status', (s) => s === 'active' || s === 'pending' || s === 'closed');
    addressContains = optString(o, 'address_contains', (s) => s.length >= 2 && s.length <= 100);
    limit = optInteger(o, 'limit', 1, 50);
    cursor = optString(o, 'cursor', (s) => s.length <= 80 && CURSOR.test(s));
  } catch (e) {
    if (e instanceof InvalidInput) return toolError(TOOL_MESSAGES.invalid_input);
    throw e;
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return fromDatabase(await listDealsFor(a.cfg, { ...a.access, status, addressContains, limit, cursor }));
}

export async function getDeal(atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let dealId: string | null;
  try {
    const o = argsObject(rawArgs, ['deal_id']);
    dealId = optString(o, 'deal_id', (s) => UUID.test(s.toLowerCase()));
    if (dealId === null) throw new InvalidInput();
  } catch (e) {
    if (e instanceof InvalidInput) return toolError(TOOL_MESSAGES.invalid_input);
    throw e;
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return fromDatabase(await getDealFor(a.cfg, { ...a.access, dealId }));
}
