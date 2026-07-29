/**
 * Reaction / Tapback utilities (BACKLOG-2280) — RENDERER copy.
 *
 * Pure, dependency-free helpers for classifying, normalizing, partitioning and
 * aggregating iMessage tapbacks (reactions). A byte-identical mirror lives at
 * `electron/utils/reactionUtils.ts` for the main process (same convention as
 * phoneNormalization.ts). Keep the two files in sync — the only intentional
 * difference is that SQL-side helpers live with the DB layer, not here.
 *
 * Apple encodes a tapback on `message.associated_message_type`:
 *   2000–2005 = reaction ADDED, 3000–3005 = reaction REMOVED
 *   (offset 0..5 = love / like / dislike / laugh / emphasize / question)
 *   2006/2007  = in-band custom/sticker tapbacks (mapped to "other")
 * The target message is `message.associated_message_guid`, an Apple part-guid
 * (`p:<index>/<guid>` or `bp:<guid>`) that must be normalized to the bare guid
 * before it can be matched against a stored message's `external_id`.
 *
 * Band cross-reference: macOSMessagesImportService/types.ts
 * (REACTION_ASSOCIATED_TYPE_MIN/MAX). These are fixed Apple protocol values.
 */

// ============================================
// CONSTANTS
// ============================================

/** Inclusive lower bound of the tapback association-type band. */
export const REACTION_TYPE_BAND_MIN = 2000;
/** Inclusive upper bound of the tapback association-type band. */
export const REACTION_TYPE_BAND_MAX = 3005;

const REACTION_ADD_MIN = 2000;
const REACTION_ADD_MAX = 2005;
const REACTION_REMOVE_MIN = 3000;
const REACTION_REMOVE_MAX = 3005;

/** Ordered tapback kinds indexed by (associated_message_type - band base). */
const KIND_BY_OFFSET = [
  "heart",
  "thumbs_up",
  "thumbs_down",
  "laugh",
  "emphasize",
  "question",
] as const;

/** A tapback kind. "other" covers in-band custom/sticker tapbacks (2006/2007). */
export type ReactionKind = (typeof KIND_BY_OFFSET)[number] | "other";

/** Emoji glyphs for evidentiary/export + pill rendering, keyed by kind. */
export const REACTION_EMOJI: Record<ReactionKind, string> = {
  heart: "❤️", // ❤️
  thumbs_up: "👍", // 👍
  thumbs_down: "👎", // 👎
  laugh: "😂", // 😂
  emphasize: "❗", // ❗
  question: "❓", // ❓
  other: "⭐", // ⭐ (custom/sticker tapback)
};

// ============================================
// CLASSIFICATION
// ============================================

/** Result of mapping a raw associated_message_type to a tapback kind. */
export interface MappedReaction {
  kind: ReactionKind;
  /** True when this event REMOVES a previously-added tapback (3000–3005). */
  isRemoval: boolean;
}

/**
 * Map an Apple `associated_message_type` to a tapback {kind, isRemoval}.
 * Returns null when the value is not a recognized tapback (out of band / null).
 */
export function mapReactionType(
  associatedType: number | null | undefined,
): MappedReaction | null {
  if (associatedType === null || associatedType === undefined) return null;
  if (associatedType >= REACTION_ADD_MIN && associatedType <= REACTION_ADD_MAX) {
    return { kind: KIND_BY_OFFSET[associatedType - REACTION_ADD_MIN], isRemoval: false };
  }
  if (associatedType >= REACTION_REMOVE_MIN && associatedType <= REACTION_REMOVE_MAX) {
    return { kind: KIND_BY_OFFSET[associatedType - REACTION_REMOVE_MIN], isRemoval: true };
  }
  // In-band custom / sticker tapbacks (adds). Their removals (3006/3007) fall
  // OUTSIDE the [2000,3005] band and are therefore treated as normal messages.
  if (associatedType === 2006 || associatedType === 2007) {
    return { kind: "other", isRemoval: false };
  }
  return null;
}

/** True when a row's associated_message_type falls in the tapback band. */
export function isReactionRow(
  row: { associated_message_type?: number | null } | null | undefined,
): boolean {
  const t = row?.associated_message_type;
  return (
    t !== null &&
    t !== undefined &&
    t >= REACTION_TYPE_BAND_MIN &&
    t <= REACTION_TYPE_BAND_MAX
  );
}

// ============================================
// GUID NORMALIZATION
// ============================================

// Apple part-guid prefix: `p:<part-index>/` (index is non-zero for multi-part
// messages) or `bp:`. A literal "p:0/" strip would ORPHAN reactions on
// multi-part parents, so we strip the whole prefix pattern.
const ASSOCIATED_GUID_PREFIX = /^(p:\d+\/|bp:)/;

/**
 * Strip Apple's part-guid prefix so a reaction's target guid matches the bare
 * `external_id` of the parent message. Returns null for empty input.
 */
export function normalizeAssociatedGuid(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const stripped = raw.replace(ASSOCIATED_GUID_PREFIX, "");
  return stripped.length > 0 ? stripped : null;
}

// ============================================
// PARTITIONING
// ============================================

/** A row carrying the two reaction columns (normal messages have them null). */
export interface ReactionCarryingRow {
  associated_message_type?: number | null;
  /** Already-normalized parent guid (normalized at import time). */
  associated_message_guid?: string | null;
}

/** Result of splitting a result set into real messages + reactions-by-parent. */
export interface PartitionedMessages<T> {
  /** Non-reaction rows, in input order. */
  messages: T[];
  /** Reaction rows grouped by their (normalized) parent guid. */
  reactionsByParentGuid: Map<string, T[]>;
}

/**
 * Split a mixed result set into displayable messages and a parent-guid → reactions
 * map. Reaction rows are keyed by their stored (already-normalized)
 * associated_message_guid. A reaction whose parent guid is absent from the
 * message set stays in the map (an "orphan" bucket) but is never looked up, so it
 * renders nothing. Reactions with no parent guid are dropped defensively.
 */
export function partitionReactions<T extends ReactionCarryingRow>(
  rows: readonly T[],
): PartitionedMessages<T> {
  const messages: T[] = [];
  const reactionsByParentGuid = new Map<string, T[]>();

  for (const row of rows) {
    if (isReactionRow(row)) {
      const parentGuid = row.associated_message_guid;
      if (parentGuid) {
        const arr = reactionsByParentGuid.get(parentGuid);
        if (arr) arr.push(row);
        else reactionsByParentGuid.set(parentGuid, [row]);
      }
      // else: reaction with no target guid — cannot attach, never render.
    } else {
      messages.push(row);
    }
  }

  return { messages, reactionsByParentGuid };
}

// ============================================
// AGGREGATION
// ============================================

/** One reaction event, reduced to what aggregation needs. */
export interface ReactionActorEvent {
  /** Stable identity of who reacted ("me" or a handle/phone). */
  actor: string;
  /** ISO timestamp of the event (add or remove). */
  sentAt: string;
  /** Raw Apple associated_message_type (2000–3005). */
  associatedType: number | null | undefined;
}

/** An active tapback kind with the actors who currently hold it. */
export interface AggregatedReaction {
  kind: ReactionKind;
  count: number;
  /** Actors currently holding this tapback (first-seen order). */
  actors: string[];
}

/**
 * Collapse add/remove events into the set of CURRENTLY-ACTIVE tapbacks.
 *
 * Per (actor, kind) the latest event by sentAt wins; a removal makes that
 * (actor, kind) inactive. Active pairs are then grouped by kind. Order-independent
 * for distinct timestamps; on an exact-timestamp tie the later-listed event wins.
 */
export function aggregateReactions(
  events: readonly ReactionActorEvent[],
): AggregatedReaction[] {
  // key = actor   kind
  const latest = new Map<
    string,
    { at: string; isRemoval: boolean; actor: string; kind: ReactionKind }
  >();

  for (const ev of events) {
    const mapped = mapReactionType(ev.associatedType);
    if (!mapped) continue;
    const key = `${ev.actor} ${mapped.kind}`;
    const prev = latest.get(key);
    if (!prev || ev.sentAt >= prev.at) {
      latest.set(key, {
        at: ev.sentAt,
        isRemoval: mapped.isRemoval,
        actor: ev.actor,
        kind: mapped.kind,
      });
    }
  }

  const byKind = new Map<ReactionKind, string[]>();
  for (const entry of latest.values()) {
    if (entry.isRemoval) continue; // inactive — a removal was the latest event
    const arr = byKind.get(entry.kind);
    if (arr) arr.push(entry.actor);
    else byKind.set(entry.kind, [entry.actor]);
  }

  const result: AggregatedReaction[] = [];
  for (const [kind, actors] of byKind) {
    result.push({ kind, count: actors.length, actors });
  }
  return result;
}
