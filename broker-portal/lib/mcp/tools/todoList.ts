/**
 * list_todos (BACKLOG-4263 PR-8). Read-only. The answer comes from the database (mcp_list_todos), keyed by the access
 * token digest the route computed; the database resolves the account and reads only that account's rows.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { listTodosFor } from '@/lib/mcp/oauth/rpc';
import { accessFor, argsObject, fromDatabase, InvalidInput, optBoolean, optString, TOOL_ANNOTATIONS, toolError } from './result';
import { LIST_TODOS_SHAPE, TODO_CURSOR, toJsonSchema } from './shapes';
import { ARG_TEXT, TOOL_MESSAGES, TOOL_TEXT } from './text';

export const LIST_TODOS_TOOL: Tool = {
  name: TOOL_TEXT.list_todos.name,
  title: TOOL_TEXT.list_todos.title,
  description: TOOL_TEXT.list_todos.description,
  inputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['open', 'done', 'all'], default: 'open', description: ARG_TEXT.td_state },
      deal_status: { type: 'string', enum: ['active', 'pending', 'closed'], description: ARG_TEXT.td_deal_status },
      due_from: { type: 'string', format: 'date', description: ARG_TEXT.td_due_from },
      due_to: { type: 'string', format: 'date', description: ARG_TEXT.td_due_to },
      without_due_date: { type: 'boolean', default: false, description: ARG_TEXT.td_without_due_date },
      only_required: { type: 'boolean', default: false, description: ARG_TEXT.td_only_required },
      cursor: { type: 'string', maxLength: 60, description: ARG_TEXT.td_cursor },
    },
    additionalProperties: false,
  },
  outputSchema: toJsonSchema(LIST_TODOS_SHAPE) as Tool['outputSchema'],
  annotations: TOOL_ANNOTATIONS,
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** a calendar date YYYY-MM-DD that exists, from 2000-01-01 to 2100-12-31 (the due dates Keepr stores) */
function isDueDay(s: string): boolean {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '2000-01-01' && s <= '2100-12-31';
}

export async function listTodos(atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let state: string | null, dealStatus: string | null, dueFrom: string | null, dueTo: string | null;
  let withoutDueDate: boolean | null, onlyRequired: boolean | null, cursor: string | null;
  try {
    const o = argsObject(rawArgs, ['state', 'deal_status', 'due_from', 'due_to', 'without_due_date', 'only_required', 'cursor']);
    state = optString(o, 'state', (s) => s === 'open' || s === 'done' || s === 'all');
    dealStatus = optString(o, 'deal_status', (s) => s === 'active' || s === 'pending' || s === 'closed');
    dueFrom = optString(o, 'due_from', isDueDay);
    dueTo = optString(o, 'due_to', isDueDay);
    withoutDueDate = optBoolean(o, 'without_due_date');
    onlyRequired = optBoolean(o, 'only_required');
    cursor = optString(o, 'cursor', (s) => TODO_CURSOR.test(s) && (s.startsWith('none|') || isDueDay(s.slice(0, 10))));
    if (dueFrom !== null && dueTo !== null && dueFrom > dueTo) throw new InvalidInput();
    if (withoutDueDate === true && (dueFrom !== null || dueTo !== null)) throw new InvalidInput();
  } catch (e) {
    if (e instanceof InvalidInput) return toolError(TOOL_MESSAGES.invalid_input);
    throw e;
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return fromDatabase(await listTodosFor(a.cfg, { ...a.access, state, dealStatus, dueFrom, dueTo, withoutDueDate, onlyRequired, cursor }));
}
