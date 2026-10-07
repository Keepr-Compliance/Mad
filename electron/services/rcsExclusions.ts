/**
 * Per-chat "Don't sync" — BACKLOG-3658 P3c.
 *
 * The user switches a chat off with the eye on its row in Google Messages'
 * conversation list. Keepr holds the list (rcs_chat_exclusions); the page and
 * the bridge only ever see conversation ids, never names or numbers.
 *
 * - A row the user switched off is stored by its conversation id (pending);
 *   the next /match of that chat also records the chat's hash (gmweb2 key), so
 *   the exclusion survives a re-pair (new conversation ids). After a re-pair a
 *   switched-off row may show "synced" until the next Sync relinks its new id.
 * - /match refuses an excluded chat for EVERY Sync (cache and transaction);
 *   each refusal is counted ("N chats not synced — switched off by you").
 * - Founder: "Don't sync" stops FUTURE syncing only — nothing already in
 *   Keepr is deleted ("if it's in Keepr it's in Keepr").
 *
 * Pure parts here; the SQL is in db/rcsImportSql.ts.
 */

/**
 * PENDING FOUNDER DECISION (one-line switch): should switching a chat OFF also
 * stop the AUTO-LINK of texts already stored from it? Default false = keep
 * auto-linking them (texts already in Keepr stay, and keep working).
 */
export const RCS_EXCLUSION_STOPS_AUTOLINK = false;

/** The eye's copy (the page shows the same words). */
export const RCS_EXCLUSION_COPY =
  "New messages from this chat won't be synced. Texts already in Keepr stay.";

/** Most ids the page may hold or send (the list is per user). */
export const RCS_EXCLUSIONS_MAX = 2000;

/** A conversation id as the page reads it from the row's address. */
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

/**
 * The gmweb2 threads the auto-link must skip because their chat is switched
 * off — none unless RCS_EXCLUSION_STOPS_AUTOLINK (or the test's `stops`).
 */
export function exclusionAutolinkThreads(hashes: readonly string[], stops: boolean = RCS_EXCLUSION_STOPS_AUTOLINK): string[] {
  if (!stops) return [];
  return hashes.filter((h) => h.length > 0).map((h) => `gmweb2-${h}`);
}
