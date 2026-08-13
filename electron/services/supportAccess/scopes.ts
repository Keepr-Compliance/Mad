/**
 * Support access log scopes (BACKLOG-2393)
 *
 * Deep logging is scoped to the subsystem under investigation, not a global
 * debug switch. A month of unscoped debug output is a disk problem, a
 * performance problem, and — worst of the three — it buries the signal in the
 * noise it generates.
 *
 * Each scope maps to one funnel we could not answer questions about. The
 * scopes are declared here in PR 1 so the mechanism has a real registry; the
 * producers that emit into them land in the follow-up (message import, contact
 * resolution, email sync, transaction auto-linking).
 *
 * ## Every scope here records counts and outcomes, never identifying detail
 *
 * That is now a property of the whole catalogue rather than a per-scope flag.
 * A fifth scope, "contact-trace", used to break it: it promised to follow one
 * named contact through every stage and to record that person's name, phone
 * number and email address. It was removed in BACKLOG-2428, because it did
 * none of that — there was no contact picker anywhere in the app, so nobody
 * could name the individual, and its single producer only fired when
 * resolution failed, dumping up to 200 raw handles. It was also never
 * requested, and it was the only reason the consent screen had to warn about
 * client PII.
 *
 * If "where did this one person go?" is ever built properly it needs a real
 * picker, tracing that actually spans discovery to link, and its own consent
 * decision — not a checkbox that quietly ships a name dump.
 */

export const SUPPORT_LOG_SCOPES = [
  "message-import",
  "contact-resolution",
  "email-sync",
  "transaction-linking",
] as const;

export type SupportLogScopeId = (typeof SUPPORT_LOG_SCOPES)[number];

export interface SupportLogScope {
  id: SupportLogScopeId;
  /** Shown on the grant screen next to a checkbox. */
  label: string;
  /** Plain-language description of what this scope records. */
  description: string;
}

export const SUPPORT_LOG_SCOPE_DETAILS: Record<
  SupportLogScopeId,
  SupportLogScope
> = {
  "message-import": {
    id: "message-import",
    label: "Text message import",
    description:
      "Chats found, messages read, what the date cutoff filtered out, attachments skipped and why, threads created or merged.",
  },
  "contact-resolution": {
    id: "contact-resolution",
    label: "Matching numbers to names",
    description:
      "Lookups attempted, and how many resolved by phone, by email, or not at all.",
  },
  "email-sync": {
    id: "email-sync",
    label: "Email sync",
    description:
      "Folders enumerated, messages fetched, duplicates removed, and which messages were linked to a transaction.",
  },
  "transaction-linking": {
    id: "transaction-linking",
    label: "Transaction auto-linking",
    description:
      "Which transactions were considered for a message, how the address comparison scored, and whether it linked or went to review.",
  },
};

/**
 * Scopes enabled when a user grants access without narrowing it.
 *
 * Every scope, since BACKLOG-2428 removed the one that was deliberately not a
 * default. Kept as an explicit list rather than derived from
 * SUPPORT_LOG_SCOPES: if a future scope should not be on by default, that must
 * be a decision someone makes here, not something that happens by omission.
 */
export const DEFAULT_SUPPORT_LOG_SCOPES: SupportLogScopeId[] = [
  "message-import",
  "contact-resolution",
  "email-sync",
  "transaction-linking",
];

export function isSupportLogScope(value: unknown): value is SupportLogScopeId {
  return (
    typeof value === "string" &&
    (SUPPORT_LOG_SCOPES as readonly string[]).includes(value)
  );
}

/** Drop anything unrecognised; never trust a scope list off the wire. */
export function normaliseScopes(value: unknown): SupportLogScopeId[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<SupportLogScopeId>();
  for (const entry of value) {
    if (isSupportLogScope(entry)) seen.add(entry);
  }
  return SUPPORT_LOG_SCOPES.filter((s) => seen.has(s));
}

export function describeScopes(scopes: SupportLogScopeId[]): string {
  if (scopes.length === 0) return "No subsystems selected";
  return scopes.map((s) => SUPPORT_LOG_SCOPE_DETAILS[s].label).join(", ");
}
