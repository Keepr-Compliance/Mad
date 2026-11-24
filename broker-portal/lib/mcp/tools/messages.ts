/**
 * list_deal_messages and get_message (BACKLOG-4263 P10). Read-only. The answer comes from the database
 * (mcp_list_deal_messages, mcp_get_message), keyed by the access token digest the route computed; the database checks
 * the connection's message permission on every call and resolves the account.
 *
 * `allowed` is the route's per-request message access (authInfo.extra.canReadMessages). The tools are listed only when
 * it is true. A call by name while it is false still goes to the database, which refuses it, and the answer shown is
 * always MESSAGE_TOOL_MESSAGES.no_access: nothing the database returns is shown.
 *
 * The result is sent as the database returned it (no cutting, no re-encoding): a body in parts joins back exactly.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { getMessageFor, listDealMessagesFor, type DataToolResult } from '@/lib/mcp/oauth/rpc';
import { accessFor, argsObject, InvalidInput, MAX_RESULT_CHARS, optInteger, optString, TOOL_ANNOTATIONS, toolError } from './result';
import { GET_MESSAGE_SHAPE, LIST_DEAL_MESSAGES_SHAPE, MESSAGE_CURSOR, toJsonSchema, UUID } from './shapes';
import { MESSAGE_ARG_TEXT, MESSAGE_TOOL_MESSAGES, MESSAGE_TOOL_TEXT, TOOL_MESSAGES } from './text';

export const LIST_DEAL_MESSAGES_TOOL: Tool = {
  name: MESSAGE_TOOL_TEXT.list_deal_messages.name,
  title: MESSAGE_TOOL_TEXT.list_deal_messages.title,
  description: MESSAGE_TOOL_TEXT.list_deal_messages.description,
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'string', format: 'uuid', description: MESSAGE_ARG_TEXT.deal_id },
      channel: { type: 'string', enum: ['email', 'text'], description: MESSAGE_ARG_TEXT.channel },
      review: { type: 'string', enum: ['all', 'linked_only'], default: 'all', description: MESSAGE_ARG_TEXT.review },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: MESSAGE_ARG_TEXT.limit },
      cursor: { type: 'string', maxLength: 80, description: MESSAGE_ARG_TEXT.cursor },
    },
    required: ['deal_id'],
    additionalProperties: false,
  },
  outputSchema: toJsonSchema(LIST_DEAL_MESSAGES_SHAPE) as Tool['outputSchema'],
  annotations: TOOL_ANNOTATIONS,
};

export const GET_MESSAGE_TOOL: Tool = {
  name: MESSAGE_TOOL_TEXT.get_message.name,
  title: MESSAGE_TOOL_TEXT.get_message.title,
  description: MESSAGE_TOOL_TEXT.get_message.description,
  inputSchema: {
    type: 'object',
    properties: {
      message_id: { type: 'string', format: 'uuid', description: MESSAGE_ARG_TEXT.message_id },
      part: { type: 'integer', minimum: 1, maximum: 100000, default: 1, description: MESSAGE_ARG_TEXT.part },
    },
    required: ['message_id'],
    additionalProperties: false,
  },
  outputSchema: toJsonSchema(GET_MESSAGE_SHAPE) as Tool['outputSchema'],
  annotations: TOOL_ANNOTATIONS,
};

/** In tools/list order, after the read tools. */
export const MESSAGE_TOOLS = [LIST_DEAL_MESSAGES_TOOL, GET_MESSAGE_TOOL];

type MessageTool = 'list' | 'get';

const tooLarge = (tool: MessageTool): string =>
  tool === 'list' ? MESSAGE_TOOL_MESSAGES.list_too_large : MESSAGE_TOOL_MESSAGES.get_too_large;

/** Database outcome -> what the AI app is shown, for a connection that may read messages. */
export function fromMessageDatabase(res: DataToolResult, tool: MessageTool): CallToolResult {
  if (res.kind === 'ok') {
    const text = JSON.stringify(res.result);
    if (text.length > MAX_RESULT_CHARS) return toolError(tooLarge(tool));
    return { content: [{ type: 'text', text }], structuredContent: res.result };
  }
  if (res.kind === 'error') {
    switch (res.error) {
      case 'not_connected':
      case 'disabled':
      case 'rate_limited':
        return toolError(TOOL_MESSAGES[res.error]);
      case 'not_entitled':
      case 'invalid_input':
        return toolError(MESSAGE_TOOL_MESSAGES[res.error]);
      case 'too_large':
        return toolError(tooLarge(tool));
      case 'not_found':
        return toolError(tool === 'list' ? MESSAGE_TOOL_MESSAGES.list_not_found : MESSAGE_TOOL_MESSAGES.get_not_found);
      default:
        return toolError(TOOL_MESSAGES.unavailable);
    }
  }
  return toolError(TOOL_MESSAGES.unavailable);
}

const isId = (s: string) => UUID.test(s.toLowerCase());

/** For a call while access is false: the raw values, as text or integer only, for the database to refuse. */
function rawText(raw: unknown, k: string): string | null {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' && v.length <= 200 ? v : null;
}
function rawInt(raw: unknown, k: string): number | null {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[k] : undefined;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export async function listDealMessages(atDigest: unknown, rawArgs: unknown, allowed: boolean): Promise<CallToolResult> {
  const a = accessFor(atDigest);
  if (!allowed) {
    if (a) {
      await listDealMessagesFor(a.cfg, {
        ...a.access,
        dealId: rawText(rawArgs, 'deal_id') ?? '',
        channel: rawText(rawArgs, 'channel'),
        review: rawText(rawArgs, 'review'),
        limit: rawInt(rawArgs, 'limit'),
        cursor: rawText(rawArgs, 'cursor'),
      });
    }
    return toolError(MESSAGE_TOOL_MESSAGES.no_access);
  }
  let dealId: string | null, channel: string | null, review: string | null, limit: number | null, cursor: string | null;
  try {
    const o = argsObject(rawArgs, ['deal_id', 'channel', 'review', 'limit', 'cursor']);
    dealId = optString(o, 'deal_id', isId);
    if (dealId === null) throw new InvalidInput();
    channel = optString(o, 'channel', (s) => s === 'email' || s === 'text');
    review = optString(o, 'review', (s) => s === 'all' || s === 'linked_only');
    limit = optInteger(o, 'limit', 1, 50);
    cursor = optString(o, 'cursor', (s) => s.length <= 80 && MESSAGE_CURSOR.test(s));
  } catch (e) {
    if (e instanceof InvalidInput) return toolError(MESSAGE_TOOL_MESSAGES.invalid_input);
    throw e;
  }
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return fromMessageDatabase(await listDealMessagesFor(a.cfg, { ...a.access, dealId, channel, review, limit, cursor }), 'list');
}

export async function getMessage(atDigest: unknown, rawArgs: unknown, allowed: boolean): Promise<CallToolResult> {
  const a = accessFor(atDigest);
  if (!allowed) {
    if (a) {
      await getMessageFor(a.cfg, { ...a.access, messageId: rawText(rawArgs, 'message_id') ?? '', part: rawInt(rawArgs, 'part') });
    }
    return toolError(MESSAGE_TOOL_MESSAGES.no_access);
  }
  let messageId: string | null, part: number | null;
  try {
    const o = argsObject(rawArgs, ['message_id', 'part']);
    messageId = optString(o, 'message_id', isId);
    if (messageId === null) throw new InvalidInput();
    part = optInteger(o, 'part', 1, 100000);
  } catch (e) {
    if (e instanceof InvalidInput) return toolError(MESSAGE_TOOL_MESSAGES.invalid_input);
    throw e;
  }
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return fromMessageDatabase(await getMessageFor(a.cfg, { ...a.access, messageId, part }), 'get');
}
