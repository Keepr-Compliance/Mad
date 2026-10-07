/**
 * RCS reaction mapping — BACKLOG-3620.
 *
 * Messages for Web shows a reaction as the emoji itself
 * (`mw-message-reactions-display span.reaction[data-e2e-reaction]`, observed on
 * the live page). Keepr renders reactions from rows whose
 * `associated_message_type` is in Apple's tapback band and whose
 * `associated_message_guid` equals the parent row's `external_id`
 * (`src/utils/reactionUtils.ts`). This module maps one to the other.
 *
 * - The six Apple tapback emojis map to their own codes (2000–2005), so they
 *   render exactly as an iPhone tapback does.
 * - Every other emoji is 2006 ("other"). The emoji itself is stored in the
 *   row's `body_text`, and the pill renders that emoji (BACKLOG-3620 ruling:
 *   each actual emoji is its own pill).
 *
 * Variation selectors (U+FE0F) are stripped before comparing: the page may show
 * "❤" or "❤️" for the same reaction.
 */

/** Apple tapback codes by bare emoji (no U+FE0F). */
const APPLE_TAPBACK_BY_EMOJI: Readonly<Record<string, number>> = {
  "\u2764": 2000, // ❤ heart
  "\u{1F44D}": 2001, // 👍 thumbs up
  "\u{1F44E}": 2002, // 👎 thumbs down
  "\u{1F602}": 2003, // 😂 laugh
  "\u203C": 2004, // ‼ emphasize
  "\u2757": 2004, // ❗ emphasize (Keepr displays emphasize as ❗)
  "\u2753": 2005, // ❓ question
};

/** "Other" tapback: rendered with the stored emoji. */
export const RCS_REACTION_OTHER = 2006;

/** Remove variation selectors and surrounding whitespace. */
export function bareEmoji(emoji: string): string {
  return String(emoji || "").replace(/\uFE0F/g, "").trim();
}

/** The `associated_message_type` for one reaction emoji. */
export function reactionTypeForEmoji(emoji: string): number {
  const bare = bareEmoji(emoji);
  return APPLE_TAPBACK_BY_EMOJI[bare] ?? RCS_REACTION_OTHER;
}

/**
 * The reaction row's own external id. One row per (message, reactor, emoji), so
 * re-sending a chat inserts no second row.
 */
export function rcsReactionExternalId(
  parentExternalId: string,
  reactor: string,
  emoji: string,
): string {
  return `${parentExternalId}:r:${reactor}:${bareEmoji(emoji)}`;
}
