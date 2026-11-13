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
import { getStatus, STATUS_TOOL, STATUS_TOOL_NAME } from './tools/status';

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
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler('tools/list', async () => ({ tools: [STATUS_TOOL] }));

  server.setRequestHandler('tools/call', async (request) => {
    if (request.params.name !== STATUS_TOOL_NAME) {
      return { content: [{ type: 'text', text: 'Unknown tool.' }], isError: true };
    }
    return getStatus(ctx.authInfo?.extra?.atDigest, protocolVersionFor(ctx), MCP_SERVER_VERSION);
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
