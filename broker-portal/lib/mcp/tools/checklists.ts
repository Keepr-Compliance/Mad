/**
 * get_deal_checklists (BACKLOG-4244). Read-only. The answer comes from the database
 * (mcp_get_deal_checklists), keyed by the access token digest the route computed.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { getDealChecklistsFor } from '@/lib/mcp/oauth/rpc';
import { accessFor, argsObject, fromDatabase, InvalidInput, optBoolean, optString, TOOL_ANNOTATIONS, toolError } from './result';
import { CHECKLISTS_SHAPE, toJsonSchema, UUID } from './shapes';
import { ARG_TEXT, TOOL_MESSAGES, TOOL_TEXT } from './text';

export const GET_DEAL_CHECKLISTS_TOOL: Tool = {
  name: TOOL_TEXT.get_deal_checklists.name,
  title: TOOL_TEXT.get_deal_checklists.title,
  description: TOOL_TEXT.get_deal_checklists.description,
  inputSchema: {
    type: 'object',
    properties: {
      deal_id: { type: 'string', format: 'uuid', description: ARG_TEXT.deal_id },
      only_open: { type: 'boolean', default: false, description: ARG_TEXT.only_open },
      checklist_id: { type: 'string', format: 'uuid', description: ARG_TEXT.checklist_id },
    },
    required: ['deal_id'],
    additionalProperties: false,
  },
  outputSchema: toJsonSchema(CHECKLISTS_SHAPE) as Tool['outputSchema'],
  annotations: TOOL_ANNOTATIONS,
};

const isUuid = (s: string) => UUID.test(s.toLowerCase());

export async function getDealChecklists(atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let dealId: string | null, onlyOpen: boolean | null, checklistId: string | null;
  try {
    const o = argsObject(rawArgs, ['deal_id', 'only_open', 'checklist_id']);
    dealId = optString(o, 'deal_id', isUuid);
    if (dealId === null) throw new InvalidInput();
    onlyOpen = optBoolean(o, 'only_open');
    checklistId = optString(o, 'checklist_id', isUuid);
  } catch (e) {
    if (e instanceof InvalidInput) return toolError(TOOL_MESSAGES.invalid_input);
    throw e;
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  return fromDatabase(await getDealChecklistsFor(a.cfg, { ...a.access, dealId, onlyOpen, checklistId }));
}
