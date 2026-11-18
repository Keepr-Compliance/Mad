/**
 * find_people (BACKLOG-4263 PR-8). Read-only. The answer comes from the database (mcp_find_people), keyed by the
 * access token digest the route computed; the database resolves the account and reads only that account's rows.
 * The database decides every match and refusal; the checks here only stop a call that cannot be valid before it
 * reaches the database.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/server';
import { findPeopleFor } from '@/lib/mcp/oauth/rpc';
import { accessFor, argsObject, fromDatabase, InvalidInput, optString, TOOL_ANNOTATIONS, toolError } from './result';
import { FIND_PEOPLE_SHAPE, toJsonSchema, UUID } from './shapes';
import { ARG_TEXT, TOOL_MESSAGES, TOOL_TEXT } from './text';

export const FIND_PEOPLE_TOOL: Tool = {
  name: TOOL_TEXT.find_people.name,
  title: TOOL_TEXT.find_people.title,
  description: TOOL_TEXT.find_people.description,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100, description: ARG_TEXT.fp_name },
      role: { type: 'string', minLength: 2, maxLength: 40, description: ARG_TEXT.fp_role },
      deal_id: { type: 'string', format: 'uuid', description: ARG_TEXT.fp_deal_id },
      email: { type: 'string', maxLength: 320, description: ARG_TEXT.fp_email },
      phone: { type: 'string', maxLength: 40, description: ARG_TEXT.fp_phone },
      cursor: { type: 'string', format: 'uuid', description: ARG_TEXT.fp_cursor },
    },
    additionalProperties: false,
  },
  outputSchema: toJsonSchema(FIND_PEOPLE_SHAPE) as Tool['outputSchema'],
  annotations: TOOL_ANNOTATIONS,
};

const EMAIL = /^[^@\s]+@[^@\s]+$/;
const PHONE = /^\+?[0-9 ().-]+$/;

export async function findPeople(atDigest: unknown, rawArgs: unknown): Promise<CallToolResult> {
  let name: string | null, role: string | null, dealId: string | null, email: string | null, phone: string | null, cursor: string | null;
  try {
    const o = argsObject(rawArgs, ['name', 'role', 'deal_id', 'email', 'phone', 'cursor']);
    name = optString(o, 'name', (s) => s.length <= 500 && s.trim().length >= 2);
    role = optString(o, 'role', (s) => s.length <= 200 && s.trim().length >= 2);
    dealId = optString(o, 'deal_id', (s) => UUID.test(s.toLowerCase()));
    email = optString(o, 'email', (s) => s.trim().length <= 320 && EMAIL.test(s.trim()));
    phone = optString(o, 'phone', (s) => {
      const digits = s.replace(/\D/g, '').length;
      return s.length <= 40 && PHONE.test(s) && digits >= 10 && digits <= 15;
    });
    cursor = optString(o, 'cursor', (s) => UUID.test(s));
    if (name === null && role === null && dealId === null && email === null && phone === null) throw new InvalidInput();
  } catch (e) {
    if (e instanceof InvalidInput) return toolError(TOOL_MESSAGES.invalid_input);
    throw e;
  }
  const a = accessFor(atDigest);
  if (!a) return toolError(TOOL_MESSAGES.unavailable);
  const res = await findPeopleFor(a.cfg, { ...a.access, name, role, dealId, email, phone, cursor });
  if (res.kind === 'day_limit') return toolError(TOOL_MESSAGES.day_limit);
  return fromDatabase(res);
}
