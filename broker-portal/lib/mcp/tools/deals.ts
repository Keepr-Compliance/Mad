/**
 * list_deals and get_deal (BACKLOG-4244), list_all_deals (BACKLOG-4263). Read-only. The answer comes from the database
 * (mcp_list_deals, mcp_get_deal), keyed by the access token digest the route computed; the
 * database resolves the account and reads only that account's rows.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { getDealFor, listAllDealsFor, listDealsFor } from '@/lib/mcp/oauth/rpc';
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
import { GET_DEAL_SHAPE, LIST_ALL_DEALS_SHAPE, LIST_DEALS_SHAPE, toJsonSchema, UUID } from './shapes';
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

export const LIST_ALL_DEALS_TOOL: Tool = {
  name: TOOL_TEXT.list_all_deals.name,
  title: TOOL_TEXT.list_all_deals.title,
  description: TOOL_TEXT.list_all_deals.description,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'pending', 'closed'], description: ARG_TEXT.status },
      closed_from: { type: 'string', format: 'date', description: ARG_TEXT.closed_from },
      closed_to: { type: 'string', format: 'date', description: ARG_TEXT.closed_to },
      cursor: { type: 'string', format: 'uuid', description: ARG_TEXT.all_cursor },
    },
    additionalProperties: false,
  },
  outputSchema: toJsonSchema(LIST_ALL_DEALS_SHAPE) as Tool['outputSchema'],
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** a calendar date YYYY-MM-DD that exists (2026-02-30 does not) */
function isDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function listAllDeals(atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let status: string | null, closedFrom: string | null, closedTo: string | null, cursor: string | null;
  try {
    const o = argsObject(rawArgs, ['status', 'closed_from', 'closed_to', 'cursor']);
    status = optString(o, 'status', (s) => s === 'active' || s === 'pending' || s === 'closed');
    closedFrom = optString(o, 'closed_from', isDay);
    closedTo = optString(o, 'closed_to', isDay);
    cursor = optString(o, 'cursor', (s) => UUID.test(s));
    if (closedFrom !== null && closedTo !== null && closedFrom > closedTo) throw new InvalidInput();
  } catch (e) {
    if (e instanceof InvalidInput) return toolError(TOOL_MESSAGES.invalid_input);
    throw e;
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return fromDatabase(await listAllDealsFor(a.cfg, { ...a.access, status, closedFrom, closedTo, cursor }));
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
