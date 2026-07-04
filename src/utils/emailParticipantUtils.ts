/**
 * Email participant formatting utilities.
 * Extracted from AttachEmailsModal and EmailThreadCard.
 * TASK-2029: Renderer-side utility deduplication.
 * BACKLOG-1762: Resolve display names from the user's Contacts when the email
 * header carries no name (or only repeats the address).
 */

/**
 * Parsed participant: the header-provided display name (if any) and the bare
 * email address. Handles both `Name <email>` and bare `email` formats and
 * strips surrounding quotes from the name (e.g. `"Sarah" <s@x.com>`).
 */
export interface ParsedParticipant {
  /** Header display name, or null when the string is a bare address. */
  name: string | null;
  /** The email address (lowercased-comparable, original case preserved). */
  email: string;
}

/**
 * Split a participant string into its display-name and email parts.
 */
export function parseParticipant(participant: string): ParsedParticipant {
  const raw = (participant || "").trim();
  const angleMatch = raw.match(/<([^>]+)>/);
  if (angleMatch) {
    const email = angleMatch[1].trim();
    const namePart = raw.slice(0, raw.indexOf("<")).trim();
    // Strip a single pair of surrounding quotes if present.
    const name = namePart.replace(/^["']|["']$/g, "").trim();
    return { name: name || null, email };
  }
  // No angle brackets: treat the whole string as the address/handle.
  return { name: null, email: raw };
}

/**
 * Whether a header-provided display name is "real" — i.e. present AND not just
 * the email address repeated into the name slot (the degenerate
 * `email <email>` case the mail providers sometimes emit).
 */
export function hasRealHeaderName(name: string | null, email: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase().trim();
  if (!n) return false;
  const e = email.toLowerCase().trim();
  // Degenerate: the "name" is just the address (with or without a trailing @-domain).
  return n !== e;
}

/**
 * Resolve a participant to a contact display name.
 *
 * Priority (header truth first):
 *   1. Real header display name (wins over contacts)
 *   2. Contact display_name matched by email address (lowercase key)
 *   3. null — no name available; callers choose their own fallback
 *      (list rows prettify the address prefix, detail views show the address).
 *
 * @param participant - `Name <email>` or bare `email`
 * @param nameMap - lowercase email -> contact display_name
 */
export function resolveContactName(
  participant: string,
  nameMap?: ReadonlyMap<string, string> | null,
): string | null {
  const { name, email } = parseParticipant(participant);
  if (hasRealHeaderName(name, email)) return name;
  if (nameMap && email) {
    const contact = nameMap.get(email.toLowerCase().trim());
    if (contact && contact.trim()) return contact.trim();
  }
  return null;
}

/**
 * Prettify an email prefix into a spaced, title-cased label.
 * e.g. `madison.delvigo` -> `Madison Delvigo`.
 */
function prettifyEmailPrefix(email: string): string {
  const atIndex = email.indexOf("@");
  const prefix = atIndex > 0 ? email.substring(0, atIndex) : email;
  return prefix
    .split(/[._-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/**
 * Resolve a participant to the best short display name.
 * Header name > contact name > bare email address.
 * Used by chat bubbles / detail lines where the fallback is the raw address.
 */
export function resolveDisplayName(
  participant: string,
  nameMap?: ReadonlyMap<string, string> | null,
): string {
  const resolved = resolveContactName(participant, nameMap);
  if (resolved) return resolved;
  const { email } = parseParticipant(participant);
  return email || (participant || "").trim();
}

/**
 * Format a single participant as `Name <email>` when a name is available,
 * otherwise the bare address. Collapses the degenerate `email <email>` case
 * to a single address. Used for detail From/To/CC lines.
 */
export function formatParticipantLine(
  participant: string,
  nameMap?: ReadonlyMap<string, string> | null,
): string {
  const { email } = parseParticipant(participant);
  const resolved = resolveContactName(participant, nameMap);
  if (resolved && (!email || resolved.toLowerCase() !== email.toLowerCase())) {
    return email ? `${resolved} <${email}>` : resolved;
  }
  return email || (participant || "").trim();
}

/**
 * Format a comma-separated participant list (e.g. `recipients`, `cc`) into a
 * display string with each entry name-resolved. Used for detail To/CC lines.
 */
export function formatParticipantListLine(
  list: string | null | undefined,
  nameMap?: ReadonlyMap<string, string> | null,
): string {
  if (!list) return "";
  return list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => formatParticipantLine(entry, nameMap))
    .join(", ");
}

/**
 * Filter out the logged-in user's email from a participant list.
 * Handles both "Name <email>" format and bare email addresses.
 *
 * @param participants - Array of participant strings
 * @param userEmail - The current user's email to filter out
 * @returns Participants without the current user
 */
export function filterSelfFromParticipants(participants: string[], userEmail?: string): string[] {
  if (!userEmail) return participants;
  const normalizedUser = userEmail.toLowerCase().trim();
  return participants.filter(p => {
    const match = p.match(/<([^>]+)>/);
    const email = match ? match[1].toLowerCase() : p.toLowerCase().trim();
    return email !== normalizedUser;
  });
}

/**
 * Format participant list for display (show first few, then "+X more").
 * Resolution order per participant: real header name > contact name > prettified
 * email prefix. Deduplicates by resolved name.
 *
 * @param participants - Array of participant strings
 * @param maxShow - Maximum number of names to show before "+X more" (default: 2)
 * @param nameMap - lowercase email -> contact display_name (BACKLOG-1762)
 * @returns Formatted string like "Alice, Bob +3"
 */
export function formatParticipants(
  participants: string[],
  maxShow: number = 2,
  nameMap?: ReadonlyMap<string, string> | null,
): string {
  if (participants.length === 0) return "Unknown";

  // Resolve each participant to a display name.
  const names = participants.map(p => {
    // Real header name > contact name (BACKLOG-1762)
    const resolved = resolveContactName(p, nameMap);
    if (resolved) return resolved;
    // Fallback: prettified email prefix (existing list-row behavior).
    const { email } = parseParticipant(p);
    return prettifyEmailPrefix(email);
  });

  // Deduplicate
  const unique = [...new Set(names)];

  if (unique.length <= maxShow) {
    return unique.join(", ");
  }
  return `${unique.slice(0, maxShow).join(", ")} +${unique.length - maxShow}`;
}
