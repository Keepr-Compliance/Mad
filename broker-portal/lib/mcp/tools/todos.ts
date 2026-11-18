/**
 * The todo write tools (BACKLOG-4263 PR-5): update_todo, add_todo, remove_todo, restore_todo.
 *
 * Every rule is enforced in the database (supabase/migrations/20261118130000_backlog_4263_mcp_todo_write_tools.sql,
 * _mcp_todo_call): the token's connection must have been granted 'mcp:todos' and the write switch must be on, the
 * owner comes from the connection, and each call is one change through the todo core. This module checks argument
 * shapes only (so a bad call makes no database call) and maps the answer. tools/list shows these tools only when
 * mcp_write_access says this connection can write (lib/mcp/server.ts).
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { addTodoFor, removeOrRestoreTodoFor, updateTodoFor, type DataToolResult, type TodoChanges } from '@/lib/mcp/oauth/rpc';
import { accessFor, argsObject, fromDatabase, InvalidInput, optString, toolError } from './result';
import { TODO_CHANGE_SHAPE, toJsonSchema, UUID } from './shapes';
import { ARG_TEXT, TOOL_MESSAGES, TOOL_TEXT } from './text';

const isUuid = (s: string) => UUID.test(s.toLowerCase());
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Loose upper bounds before the database's own (title 300, note 4000 after cleaning). */
const TITLE_MAX = 2000;
const NOTE_MAX = 16000;

const OUTPUT = toJsonSchema(TODO_CHANGE_SHAPE) as Tool['outputSchema'];
const REQUEST_ID_PROP = { type: 'string', pattern: REQUEST_ID.source, description: ARG_TEXT.request_id };

/** Annotations: none is read-only; only remove_todo is destructive; a repeated update, remove or restore changes nothing more. */
const WRITE = { readOnlyHint: false, openWorldHint: false } as const;

export const UPDATE_TODO_TOOL: Tool = {
  name: TOOL_TEXT.update_todo.name,
  title: TOOL_TEXT.update_todo.title,
  description: TOOL_TEXT.update_todo.description,
  inputSchema: {
    type: 'object',
    properties: {
      item_id: { type: 'string', format: 'uuid', description: ARG_TEXT.item_id },
      done: { type: 'boolean', description: ARG_TEXT.done },
      title: { type: 'string', minLength: 1, maxLength: 300, description: ARG_TEXT.title },
      note: { type: ['string', 'null'], maxLength: 4000, description: ARG_TEXT.note },
      due_date: { type: ['string', 'null'], format: 'date', description: ARG_TEXT.due_date },
      request_id: REQUEST_ID_PROP,
    },
    required: ['item_id'],
    additionalProperties: false,
  },
  outputSchema: OUTPUT,
  annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
};

export const ADD_TODO_TOOL: Tool = {
  name: TOOL_TEXT.add_todo.name,
  title: TOOL_TEXT.add_todo.title,
  description: TOOL_TEXT.add_todo.description,
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'string', format: 'uuid', description: ARG_TEXT.add_deal_id },
      title: { type: 'string', minLength: 1, maxLength: 300, description: ARG_TEXT.add_title },
      note: { type: ['string', 'null'], maxLength: 4000, description: ARG_TEXT.note },
      due_date: { type: ['string', 'null'], format: 'date', description: ARG_TEXT.due_date },
      request_id: REQUEST_ID_PROP,
    },
    required: ['deal_id', 'title'],
    additionalProperties: false,
  },
  outputSchema: OUTPUT,
  annotations: { ...WRITE, destructiveHint: false, idempotentHint: false },
};

const itemOnly = (description: string) => ({
  type: 'object' as const,
  properties: { item_id: { type: 'string', format: 'uuid', description: ARG_TEXT.item_id }, request_id: REQUEST_ID_PROP },
  required: ['item_id'],
  additionalProperties: false,
  description,
});

export const REMOVE_TODO_TOOL: Tool = {
  name: TOOL_TEXT.remove_todo.name,
  title: TOOL_TEXT.remove_todo.title,
  description: TOOL_TEXT.remove_todo.description,
  inputSchema: itemOnly(TOOL_TEXT.remove_todo.title),
  outputSchema: OUTPUT,
  annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
};

export const RESTORE_TODO_TOOL: Tool = {
  name: TOOL_TEXT.restore_todo.name,
  title: TOOL_TEXT.restore_todo.title,
  description: TOOL_TEXT.restore_todo.description,
  inputSchema: itemOnly(TOOL_TEXT.restore_todo.title),
  outputSchema: OUTPUT,
  annotations: { ...WRITE, destructiveHint: false, idempotentHint: true },
};

export const WRITE_TOOLS: Tool[] = [UPDATE_TODO_TOOL, ADD_TODO_TOOL, REMOVE_TODO_TOOL, RESTORE_TODO_TOOL];

/** A string up to max characters, or null/absent. */
function optText(o: Record<string, unknown>, k: string, max: number): string | null {
  return optString(o, k, (s) => s.length <= max);
}

/** A due date: absent -> undefined, null -> null, else YYYY-MM-DD. */
function dueArg(o: Record<string, unknown>): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(o, 'due_date')) return undefined;
  return optString(o, 'due_date', (s) => DAY.test(s));
}

function answer(res: DataToolResult): CallToolResult {
  if (res.kind === 'error' && res.error === 'not_found') return toolError(TOOL_MESSAGES.todo_not_found);
  if (res.kind === 'error' && res.error === 'busy') return toolError(TOOL_MESSAGES.busy);
  return fromDatabase(res);
}

function invalid(e: unknown): CallToolResult {
  if (e instanceof InvalidInput) return toolError(TOOL_MESSAGES.invalid_input);
  throw e;
}

export async function updateTodo(atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let itemId: string | null, requestId: string | null;
  const changes: TodoChanges = {};
  try {
    const o = argsObject(rawArgs, ['item_id', 'done', 'title', 'note', 'due_date', 'request_id']);
    itemId = optString(o, 'item_id', isUuid);
    if (itemId === null) throw new InvalidInput();
    requestId = optString(o, 'request_id', (s) => REQUEST_ID.test(s));
    if (o.done !== undefined) {
      if (typeof o.done !== 'boolean') throw new InvalidInput();
      changes.done = o.done;
    }
    if (o.title !== undefined) {
      const t = optText(o, 'title', TITLE_MAX);
      if (t === null) throw new InvalidInput();
      changes.title = t;
    }
    if (Object.prototype.hasOwnProperty.call(o, 'note')) changes.note = optText(o, 'note', NOTE_MAX);
    const due = dueArg(o);
    if (due !== undefined) changes.due_date = due;
    if (Object.keys(changes).length === 0) throw new InvalidInput();
  } catch (e) {
    return invalid(e);
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return answer(await updateTodoFor(a.cfg, { ...a.access, itemId, changes, requestId }));
}

export async function addTodo(atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let dealId: string | null, title: string | null, note: string | null, dueDate: string | null, requestId: string | null;
  try {
    const o = argsObject(rawArgs, ['deal_id', 'title', 'note', 'due_date', 'request_id']);
    dealId = optString(o, 'deal_id', isUuid);
    title = optText(o, 'title', TITLE_MAX);
    if (dealId === null || title === null) throw new InvalidInput();
    note = optText(o, 'note', NOTE_MAX);
    dueDate = dueArg(o) ?? null;
    requestId = optString(o, 'request_id', (s) => REQUEST_ID.test(s));
  } catch (e) {
    return invalid(e);
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return answer(await addTodoFor(a.cfg, { ...a.access, dealId, title, note, dueDate, requestId }));
}

async function itemTool(fn: 'mcp_remove_todo' | 'mcp_restore_todo', atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let itemId: string | null, requestId: string | null;
  try {
    const o = argsObject(rawArgs, ['item_id', 'request_id']);
    itemId = optString(o, 'item_id', isUuid);
    if (itemId === null) throw new InvalidInput();
    requestId = optString(o, 'request_id', (s) => REQUEST_ID.test(s));
  } catch (e) {
    return invalid(e);
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return answer(await removeOrRestoreTodoFor(a.cfg, fn, { ...a.access, itemId, requestId }));
}

export const removeTodo = (atDigest: unknown, rawArgs: unknown) => itemTool('mcp_remove_todo', atDigest, rawArgs);
export const restoreTodo = (atDigest: unknown, rawArgs: unknown) => itemTool('mcp_restore_todo', atDigest, rawArgs);
