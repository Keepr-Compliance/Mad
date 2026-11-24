/**
 * MCP server for the portal (BACKLOG-4237, BACKLOG-4238).
 *
 * One fresh low-level Server per HTTP request (stateless). 2025-era clients are
 * served by the SDK's stateless legacy leg; 2026-07-28 clients by the modern leg.
 * The route passes the access token digest in authInfo.extra.atDigest; the SDK
 * hands authInfo to this factory unchanged. Tools send the digest to the
 * database, which resolves the owner.
 */

import {
  createMcpHandler,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  Server,
  type McpHttpHandler,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { getPrompt, PROMPTS } from './prompts';
import { getDealChecklists, GET_DEAL_CHECKLISTS_TOOL } from './tools/checklists';
import { getDeal, GET_DEAL_TOOL, listAllDeals, LIST_ALL_DEALS_TOOL, listDeals, LIST_DEALS_TOOL } from './tools/deals';
import { getMessage, listDealMessages, MESSAGE_TOOLS } from './tools/messages';
import { findPeople, FIND_PEOPLE_TOOL } from './tools/people';
import { getStatus, STATUS_TOOL, STATUS_TOOL_NAME } from './tools/status';
import { instructionsFor, MESSAGE_TOOL_TEXT, TOOL_MESSAGES } from './tools/text';
import { listTodos, LIST_TODOS_TOOL } from './tools/todoList';
import { addTodo, removeTodo, restoreTodo, updateTodo, WRITE_TOOLS } from './tools/todos';

/** The read tools, in the order tools/list returns them. */
export const TOOLS = [STATUS_TOOL, LIST_DEALS_TOOL, GET_DEAL_TOOL, GET_DEAL_CHECKLISTS_TOOL, LIST_ALL_DEALS_TOOL, FIND_PEOPLE_TOOL, LIST_TODOS_TOOL];

/**
 * BACKLOG-4263 PR-5: the route asks the database once per request whether this token's connection can write
 * (mcp_write_access: granted 'mcp:todos' AND the write switch on) and passes it as authInfo.extra.canWrite. Only
 * exactly true lists the write tools and sends the write instructions and prompt lines; anything else is read-only.
 */
export function canWriteOf(ctx: McpRequestContext): boolean {
  return ctx.authInfo?.extra?.canWrite === true;
}
/**
 * BACKLOG-4263 P10: the route asks the database once per request whether this token's connection may read the emails
 * and texts of its deals (mcp_message_access) and passes it as authInfo.extra.canReadMessages. Only exactly true lists
 * the message tools and adds the messages paragraph to the instructions. Independent of canWrite.
 */
export function canReadMessagesOf(ctx: McpRequestContext): boolean {
  return ctx.authInfo?.extra?.canReadMessages === true;
}
export function toolsFor(canWrite: boolean, canReadMessages = false) {
  return [...TOOLS, ...(canReadMessages ? MESSAGE_TOOLS : []), ...(canWrite ? WRITE_TOOLS : [])];
}

export const MCP_SERVER_NAME = 'keepr';
export const MCP_SERVER_VERSION = '0.1.0';

/**
 * The protocol revision this request is served under. Both eras send it in the
 * MCP-Protocol-Version header (the SDK does not pass the request's _meta
 * envelope through to tools/call params; measured with SDK 2.4.0).
 */
function protocolVersionFor(ctx: McpRequestContext): string {
  const fromHeader = ctx.requestInfo?.headers.get('mcp-protocol-version');
  if (fromHeader) return fromHeader;
  return DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
}

export function createMcpServer(ctx: McpRequestContext): Server {
  // The low-level Server is marked deprecated in favour of McpServer; the plan
  // asks for the low-level one so tool registration stays explicit.
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {} }, instructions: instructionsFor(canWriteOf(ctx), canReadMessagesOf(ctx)) }
  );

  server.setRequestHandler('tools/list', async () => ({ tools: toolsFor(canWriteOf(ctx), canReadMessagesOf(ctx)) }));

  // Prompts are text only: no tool and no database call (lib/mcp/prompts.ts).
  server.setRequestHandler('prompts/list', async () => ({ prompts: PROMPTS }));
  server.setRequestHandler('prompts/get', async (request) => getPrompt(request.params.name, request.params.arguments, canWriteOf(ctx)));

  const atDigest = () => ctx.authInfo?.extra?.atDigest;
  const calls = new Map<string, (_args: unknown) => Promise<CallToolResult>>([
    [STATUS_TOOL_NAME, () => getStatus(atDigest(), protocolVersionFor(ctx), MCP_SERVER_VERSION)],
    [LIST_DEALS_TOOL.name, (args) => listDeals(atDigest(), args)],
    [GET_DEAL_TOOL.name, (args) => getDeal(atDigest(), args)],
    [GET_DEAL_CHECKLISTS_TOOL.name, (args) => getDealChecklists(atDigest(), args)],
    [LIST_ALL_DEALS_TOOL.name, (args) => listAllDeals(atDigest(), args)],
    [FIND_PEOPLE_TOOL.name, (args) => findPeople(atDigest(), args)],
    [LIST_TODOS_TOOL.name, (args) => listTodos(atDigest(), args)],
    // message tools: always called; without message access the database refuses and nothing it returns is shown
    [MESSAGE_TOOL_TEXT.list_deal_messages.name, (args) => listDealMessages(atDigest(), args, canReadMessagesOf(ctx))],
    [MESSAGE_TOOL_TEXT.get_message.name, (args) => getMessage(atDigest(), args, canReadMessagesOf(ctx))],
    // write tools: the database refuses them (read_only) unless this connection may write
    ['update_todo', (args) => updateTodo(atDigest(), args)],
    ['add_todo', (args) => addTodo(atDigest(), args)],
    ['remove_todo', (args) => removeTodo(atDigest(), args)],
    ['restore_todo', (args) => restoreTodo(atDigest(), args)],
  ]);

  server.setRequestHandler('tools/call', async (request) => {
    const run = calls.get(request.params.name);
    if (!run) {
      return { content: [{ type: 'text', text: TOOL_MESSAGES.unknown_tool }], isError: true };
    }
    return run(request.params.arguments);
  });

  return server;
}

let handler: McpHttpHandler | null = null;

export function getMcpHandler(): McpHttpHandler {
  if (!handler) {
    handler = createMcpHandler(createMcpServer, {
      legacy: 'stateless',
      maxRequestBodySize: 256 * 1024,
      // Name only: an SDK error message can quote request content.
      onerror: (error) => console.error('[mcp] handler error:', error.name),
    });
  }
  return handler;
}
