/**
 * get_status — the one MCP tool in BACKLOG-4237. Reads no user data.
 */

import type { Tool } from '@modelcontextprotocol/server';

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

export interface StatusResult {
  connected: true;
  protocolVersion: string;
  serverVersion: string;
}

export function getStatus(protocolVersion: string, serverVersion: string): StatusResult {
  return { connected: true, protocolVersion, serverVersion };
}
