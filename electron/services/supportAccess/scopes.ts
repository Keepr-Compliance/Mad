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
 * resolution, email sync, transaction auto-linking, per-contact tracing).
 */

export const SUPPORT_LOG_SCOPES = [
  "message-import",
  "contact-resolution",
  "email-sync",
  "transaction-linking",
  "contact-trace",
] as const;

export type SupportLogScopeId = (typeof SUPPORT_LOG_SCOPES)[number];

export interface SupportLogScope {
  id: SupportLogScopeId;
  /** Shown on the grant screen next to a checkbox. */
  label: string;
  /** Plain-language description of what this scope records. */
  description: string;
  /**
   * True when the scope can record identifying detail about individual people
   * (rather than counts). Surfaced separately on the grant screen because it is
   * a materially different thing to agree to.
   */
  identifying: boolean;
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
    identifying: false,
  },
  "contact-resolution": {
    id: "contact-resolution",
    label: "Matching numbers to names",
    description:
      "Lookups attempted, and how many resolved by phone, by email, or not at all.",
    identifying: false,
  },
  "email-sync": {
    id: "email-sync",
    label: "Email sync",
    description:
      "Folders enumerated, messages fetched, duplicates removed, and which messages were linked to a transaction.",
    identifying: false,
  },
  "transaction-linking": {
    id: "transaction-linking",
    label: "Transaction auto-linking",
    description:
      "Which transactions were considered for a message, how the address comparison scored, and whether it linked or went to review.",
    identifying: false,
  },
  "contact-trace": {
    id: "contact-trace",
    label: "Follow a specific contact",
    description:
      "Follows one named contact through every stage. This records that contact's name, phone number and email address so support can see exactly where they were dropped. Counts alone cannot answer 'this one person is missing'.",
    identifying: true,
  },
};

/**
 * Scopes enabled when a user grants access without narrowing it. Everything
 * except per-contact tracing, which names an individual and should be an
 * explicit choice rather than a default.
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
