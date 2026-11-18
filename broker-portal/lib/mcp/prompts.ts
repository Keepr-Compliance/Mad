/**
 * MCP prompts (BACKLOG-4244). A prompt is message text for the AI app; fetching one calls no tool
 * and no database function. Wording lives in ./tools/text.ts.
 *
 * Errors: an unknown prompt name or a bad argument is JSON-RPC -32602 (InvalidParams) with a fixed
 * text from PROMPT_MESSAGES.
 *
 * The address argument of brief_me_on_a_deal (cleanAddress):
 * - missing, not a string, or longer than PROMPT_ADDRESS_LIMITS.rawMax UTF-16 units: refused;
 * - every Default_Ignorable_Code_Point is removed (the set of _mcp_ign() in the 4244 data-tools
 *   migration; none kept, an address search needs no joiners);
 * - the typographic apostrophes U+2018 and U+2019 (phone keyboards type them) become ';
 * - every other character that is not a letter, mark, number, space or one of # , . - ' / & becomes
 *   a space (control characters and line breaks included), so no quote, backslash, angle bracket,
 *   backtick or line break can reach the message;
 * - runs of spaces become one space, and the ends are trimmed;
 * - the result must be PROMPT_ADDRESS_LIMITS.min to .max UTF-16 units (the address_contains bounds of
 *   list_deals, measured the same way); it is never shortened, since a cut address searches for something else.
 * The cleaned text is placed in double quotes after a line saying it is search text, not
 * instructions. The rule bounds and quotes the text; it does not remove words from it.
 */

import { ProtocolError, ProtocolErrorCode, type GetPromptResult, type Prompt } from '@modelcontextprotocol/server';
import { PROMPT_ADDRESS_LIMITS, PROMPT_MESSAGES, PROMPT_TEXT, PROMPT_WRITE_LINES } from './tools/text';

const { whats_on_my_plate: PLATE, due_this_week: WEEK, brief_me_on_a_deal: BRIEF } = PROMPT_TEXT;

/** The prompts, in the order prompts/list returns them. */
export const PROMPTS: Prompt[] = [
  { name: PLATE.name, title: PLATE.title, description: PLATE.description },
  { name: WEEK.name, title: WEEK.title, description: WEEK.description },
  {
    name: BRIEF.name,
    title: BRIEF.title,
    description: BRIEF.description,
    arguments: [{ name: BRIEF.argument.name, description: BRIEF.argument.description, required: true }],
  },
];

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const TYPOGRAPHIC_APOSTROPHE = /[\u2018\u2019]/g;
const NOT_ALLOWED = /[^\p{L}\p{M}\p{N} #,.\-'/&]/gu;

function invalid(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, PROMPT_MESSAGES.invalid_arguments);
}

/** The address text as it goes into the message, or null when it is refused. */
export function cleanAddress(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > PROMPT_ADDRESS_LIMITS.rawMax) return null;
  const cleaned = raw.replace(IGNORABLE, '').replace(TYPOGRAPHIC_APOSTROPHE, "'").replace(NOT_ALLOWED, ' ').replace(/ {2,}/g, ' ').trim();
  // UTF-16 length, as list_deals measures address_contains
  const n = cleaned.length;
  return n >= PROMPT_ADDRESS_LIMITS.min && n <= PROMPT_ADDRESS_LIMITS.max ? cleaned : null;
}

/** BACKLOG-4263 PR-5: the read-only lines are kept for a connection that cannot change todos, swapped otherwise. */
function forAccess(text: string, canWrite: boolean): string {
  if (!canWrite) return text;
  return text
    .split('\n')
    .map((line) => PROMPT_WRITE_LINES.find(([ro]) => ro === line)?.[1] ?? line)
    .join('\n');
}

function userMessage(description: string, text: string): GetPromptResult {
  return { description, messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/** Argument keys present on the request (an omitted `arguments` is none). */
function argKeys(args: Record<string, string> | undefined): string[] {
  return args ? Object.keys(args) : [];
}

export function getPrompt(name: string, args: Record<string, string> | undefined, canWrite = false): GetPromptResult {
  switch (name) {
    case PLATE.name:
    case WEEK.name: {
      if (argKeys(args).length > 0) throw invalid();
      const p = name === PLATE.name ? PLATE : WEEK;
      return userMessage(p.description, forAccess(p.message, canWrite));
    }
    case BRIEF.name: {
      const keys = argKeys(args);
      if (keys.some((k) => k !== BRIEF.argument.name)) throw invalid();
      const address = cleanAddress(args?.[BRIEF.argument.name]);
      if (address === null) throw invalid();
      return userMessage(BRIEF.description, `${forAccess(BRIEF.head, canWrite)}\n"${address}"`);
    }
    default:
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, PROMPT_MESSAGES.unknown_prompt);
  }
}
