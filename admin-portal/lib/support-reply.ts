/**
 * Support reply helpers (BACKLOG-3702).
 *
 * Pure functions shared by the ticket page, the reply composer and the
 * customer reply notification:
 * - getStaffDisplayName: the signed-in staff member's name, used both for the
 *   {{agent_name}} template variable and the "X replied" email header, so the
 *   two can never disagree.
 * - applyTemplateVariables: fills response-template variables and never leaves
 *   a raw {{token}} in text that will reach a customer.
 * - replyBodyForEmail: the full reply text for the notification email.
 */

export const DEFAULT_STAFF_NAME = 'Support Team';

interface StaffUserLike {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string {
  const value = meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * First name derived from an email local part:
 * "jane.doe@x.com" -> "Jane", "sam_lee+support@x.com" -> "Sam".
 * Returns '' when nothing alphabetic is left.
 */
export function firstNameFromEmail(email: string | null | undefined): string {
  if (!email) return '';
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._+\-]/)[0] ?? '';
  const letters = first.replace(/[^A-Za-z]/g, '');
  return letters ? capitalize(letters) : '';
}

/**
 * Display name for the signed-in staff member.
 * full_name -> name -> first_name + last_name -> first name from email -> 'Support Team'.
 */
export function getStaffDisplayName(user: StaffUserLike | null | undefined): string {
  const meta = user?.user_metadata;
  const fullName = metaString(meta, 'full_name');
  if (fullName) return fullName;
  const name = metaString(meta, 'name');
  if (name) return name;
  const joined = [metaString(meta, 'first_name'), metaString(meta, 'last_name')]
    .filter(Boolean)
    .join(' ');
  if (joined) return joined;
  return firstNameFromEmail(user?.email) || DEFAULT_STAFF_NAME;
}

export interface TemplateVariables {
  customerName?: string;
  ticketNumber?: number;
  agentName?: string;
}

/** Used when the customer's name is unknown: "Hi {{customer_name}}," -> "Hi there,". */
export const CUSTOMER_NAME_FALLBACK = 'there';

/**
 * Fill response-template variables. A variable with no value falls back
 * (customer name -> "there", agent name -> "Support Team"); a variable with no
 * sensible fallback, or one we do not recognise, is removed so the customer
 * never sees raw braces.
 */
export function applyTemplateVariables(body: string, vars: TemplateVariables): string {
  const customerName = vars.customerName?.trim() || CUSTOMER_NAME_FALLBACK;
  const agentName = vars.agentName?.trim() || DEFAULT_STAFF_NAME;
  const ticketNumber = vars.ticketNumber ? String(vars.ticketNumber) : '';

  let removedAny = false;
  const filled = body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, rawKey: string) => {
    const key = rawKey.toLowerCase();
    if (key === 'customer_name') return customerName;
    if (key === 'agent_name') return agentName;
    if (key === 'ticket_number' && ticketNumber) return ticketNumber;
    removedAny = true;
    return '';
  });

  if (!removedAny) return filled;
  // Tidy the gap a removed token leaves behind, without touching line breaks.
  return filled.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?;:])/g, '$1');
}

/**
 * The full reply as plain text for the customer notification email.
 * Replies are typed into a plain textarea and shown as plain text, so the text
 * is sent verbatim (HTML escaping happens in the email template). Only line
 * endings are normalised, runs of 3+ newlines collapse to one blank line, and
 * outer whitespace is trimmed.
 */
export function replyBodyForEmail(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
