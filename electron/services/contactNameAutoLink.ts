/**
 * Unique-exact-name auto-linking (BACKLOG-2410 part 3)
 *
 * ===========================================================================
 * THE RULE, IN THE FOUNDER'S WORDS (2026-08-02, and its later clarification)
 * ===========================================================================
 * Count every record carrying that exact first+last name across ALL sources AND
 * all already-saved contacts. Auto-link ONLY when that count is exactly two:
 * one from an email source, one from a phone source.
 *
 *   | count | composition                        | action    |
 *   |-------|------------------------------------|-----------|
 *   | 2     | one email source + one phone source| AUTO-LINK |
 *   | 2     | both from the same source family   | ask       |
 *   | 3+    | any                                | ask       |
 *   | any   | includes an already-saved contact  | it counts |
 *
 * The condition is: "this name identifies exactly one person on each side, and
 * nobody else anywhere." Anything looser and four Mike Johnsons start pairing
 * off.
 *
 * ===========================================================================
 * WHY THIS IS SAFE WHERE THE CREDIT BUREAUX WERE NOT
 * ===========================================================================
 * The failure everyone cites (TransUnion) matched strangers against a NATIONAL
 * list, where "John Smith" collides constantly. This runs inside ONE user's own
 * data, where two records sharing a full name are usually one person. The
 * frequency gate is what keeps that true: it is term-frequency weighting — rare
 * values upweighted, common values discarded — and it needs no model, no
 * training data and no threshold to tune. It is a `GROUP BY`.
 *
 * ===========================================================================
 * SUFFIXES ARE NOT STRIPPED. THIS IS THE MOST IMPORTANT LINE IN THE FILE.
 * ===========================================================================
 * The dangerous case is not two records both reading "John Smith Jr". It is one
 * reading "John Smith Jr" and the other "John Smith" — because normalisation
 * that removes the suffix makes A FATHER AND A SON IDENTICAL, and they share a
 * surname, usually an address, and often a phone. This is the single most
 * litigated false-merge pattern in the credit-bureau world; the "mixed file"
 * genre is largely Jr/Sr and same-name relatives.
 *
 * The protection is structural, not a special case: because the suffix token is
 * KEPT, "john smith jr" and "john smith" produce different keys and never land
 * in the same group at all. `hasGenerationalSuffix` is then a second, explicit
 * bar on top — a group where BOTH sides say "Jr" is still refused, per the
 * founder's "if either side carries a generational suffix, the pair goes to the
 * ask band regardless of how well everything else matches."
 *
 * IF YOU EVER ADD SUFFIX STRIPPING TO `normalizeNameKey`, YOU HAVE REBUILT THE
 * BUG. The negative control for it is in the test file; run it.
 *
 * ===========================================================================
 * NICKNAMES DO NOT AUTO-LINK
 * ===========================================================================
 * Mike/Michael, Trish/Patricia, Bob/Robert are usually the same person, and
 * "usually" is not the standard for something that merges without being asked.
 * There is deliberately NO nickname table in this file. They fall into different
 * groups and reach the ask band on their own; nothing special is needed to make
 * that happen, and adding an equivalence map is what would break it.
 *
 * ===========================================================================
 * MIDDLE NAMES — AN OPEN QUESTION, RESOLVED CONSERVATIVELY
 * ===========================================================================
 * The founder listed "does John Smith match John A. Smith?" as still to decide
 * and never answered it. It is decided here in the SAFE direction: the key is
 * the FULL normalised token sequence, so "john a smith" and "john smith" are
 * different names and never auto-link.
 *
 * That follows from the founder's own normalisation constraint rather than from
 * a preference — "Nothing that removes a token." Matching "John Smith" to
 * "John A. Smith" requires dropping the "A", which is removing a token. The
 * looser reading can be adopted later by one change here; the merges the looser
 * reading would have made cannot be undone later. FLAGGED FOR THE FOUNDER.
 */

import { dbAll } from "./db/core/dbConnection";
import type { ExternalContactSource } from "./db/externalContactDbService";
import { createLink, findContactIdBySourceRecord } from "./db/contactSourceLinkDbService";
import { hasCannotLink, type LinkProposalReason } from "./db/contactLinkReviewDbService";
import { sourceFamily } from "./contactLinkEvidence";
import { applyLinkedSourceValues } from "./contactSourceValues";
import logService from "./logService";

// ---------------------------------------------------------------------------
// NORMALISATION — case, whitespace, accents, punctuation. NOTHING ELSE.
// ---------------------------------------------------------------------------

/**
 * Generational suffixes. Matched on the LAST token only.
 *
 * Last-token-only matters: "John V Smith" has V as a middle initial, not a
 * suffix, and a contains-anywhere test would misread it. "John Smith V" is a
 * suffix and is caught. A single "V" as the final token of a two-token name
 * ("John V") is read as a suffix and therefore BLOCKED from auto-linking — the
 * wrong reading, but it fails towards asking rather than towards merging, which
 * is the direction every ambiguity in this file resolves.
 */
const GENERATIONAL_SUFFIXES = new Set([
  "jr",
  "jnr",
  "sr",
  "snr",
  "ii",
  "iii",
  "iv",
  "v",
  "2nd",
  "3rd",
  "4th",
]);

export interface NormalizedName {
  /** The full normalised token sequence, space-joined. The grouping key. */
  key: string;
  tokens: string[];
  /** Last token is a generational suffix. Blocks auto-linking outright. */
  hasGenerationalSuffix: boolean;
}

/**
 * Case, surrounding whitespace, accents and punctuation INSIDE a token are
 * removed. No token is ever dropped, reordered, expanded or substituted.
 *
 * A token that is nothing but punctuation ("-", "&") normalises to the empty
 * string and is discarded. That is not "removing a token" in the sense the rule
 * bars: it carries no name content, and keeping it would make "Smith - John" and
 * "Smith John" different people.
 *
 * Returns null for anything that cannot yield a first AND a last name; a
 * one-token name can never satisfy "exact first+last".
 */
export function normalizeNameKey(raw: string | null | undefined): NormalizedName | null {
  if (!raw) return null;
  const tokens = raw
    .normalize("NFD")
    // Combining marks: café -> cafe. An accent is a rendering of the same name.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((t) => t.length > 0);

  if (tokens.length < 2) return null;

  return {
    key: tokens.join(" "),
    tokens,
    hasGenerationalSuffix: GENERATIONAL_SUFFIXES.has(tokens[tokens.length - 1]),
  };
}

// ---------------------------------------------------------------------------
// THE GROUP AND ITS VERDICT — a pure function, so it can be tested on exact sets
// ---------------------------------------------------------------------------

export interface NameSourceMember {
  kind: "source";
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  name: string;
  /** The saved contact that already owns this record, via the crosswalk. */
  ownerContactId: string | null;
}

export interface NameContactMember {
  kind: "contact";
  contactId: string;
  name: string;
}

export type NameMember = NameSourceMember | NameContactMember;

export interface NameGroup {
  key: string;
  displayName: string;
  hasGenerationalSuffix: boolean;
  members: NameMember[];
}

export interface AutoLinkAction {
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  contactId: string;
}

export interface AskPair {
  contactId: string;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
}

export type NameGroupDecision =
  /** Exactly two, cross-family, unowned side joins the owned side's contact. */
  | { kind: "auto_link"; action: AutoLinkAction; holderCount: number }
  /** Exactly two, cross-family, but neither side is a saved contact yet. */
  | { kind: "not_yet_imported"; holderCount: number }
  /** Exactly two, cross-family, and both already point at the same contact. */
  | { kind: "already_linked"; holderCount: number }
  /** Anything the rule refuses to decide, with the pairs to ask about. */
  | { kind: "ask"; reason: LinkProposalReason; pairs: AskPair[]; holderCount: number }
  /** Nothing to do and nothing to ask — fewer than two holders, or no target. */
  | { kind: "skip"; holderCount: number };

/**
 * Apply the rule to one name group.
 *
 * ===========================================================================
 * THE COLLAPSE STEP, AND WHY THE RULE WOULD OTHERWISE NEVER FIRE
 * ===========================================================================
 * The clarification says an already-saved contact carrying the name "counts
 * toward the total — it cannot be excluded from the tally." Read as "every row
 * is a holder", the rule is dead on arrival: the moment one of the two source
 * records is imported, a saved contact with that name exists, the tally reads 3,
 * and nothing can ever auto-link.
 *
 * A saved contact that is ALREADY CROSSWALKED to one of the group's source
 * records is not an additional person — it IS that record's person, counted
 * twice. So it is collapsed into it. A saved contact linked to NOTHING in the
 * group is a genuine third holder and is counted, which is the case the
 * clarification is actually about: another person of the same name.
 *
 * This is a de-duplication of one holder, not a loosening of the tally.
 */
export function evaluateNameGroup(group: NameGroup): NameGroupDecision {
  const sources = group.members.filter((m): m is NameSourceMember => m.kind === "source");
  const contacts = group.members.filter((m): m is NameContactMember => m.kind === "contact");

  const ownedContactIds = new Set(
    sources.map((s) => s.ownerContactId).filter((id): id is string => !!id),
  );
  const standaloneContacts = contacts.filter((c) => !ownedContactIds.has(c.contactId));

  const holderCount = sources.length + standaloneContacts.length;

  // Every saved contact this name touches — the only things a source record
  // could be linked TO. Owners first so the ordering is deterministic.
  const candidateContactIds = [
    ...ownedContactIds,
    ...standaloneContacts.map((c) => c.contactId),
  ];

  if (holderCount < 2) {
    return { kind: "skip", holderCount };
  }

  const twoCrossFamilySources =
    holderCount === 2 &&
    sources.length === 2 &&
    standaloneContacts.length === 0 &&
    sourceFamily(sources[0].sourceType) !== sourceFamily(sources[1].sourceType);

  if (twoCrossFamilySources && !group.hasGenerationalSuffix) {
    const [a, b] = sources;
    if (a.ownerContactId && b.ownerContactId) {
      if (a.ownerContactId === b.ownerContactId) {
        return { kind: "already_linked", holderCount };
      }
      // Two saved people, one on each side. Joining them is a MERGE, which
      // destroys a distinction the user may have made deliberately. Ask.
      return {
        kind: "ask",
        reason: "name_two_saved_contacts",
        pairs: [
          { contactId: b.ownerContactId, sourceType: a.sourceType, sourceRecordId: a.sourceRecordId },
          { contactId: a.ownerContactId, sourceType: b.sourceType, sourceRecordId: b.sourceRecordId },
        ],
        holderCount,
      };
    }
    if (!a.ownerContactId && !b.ownerContactId) {
      // The person exists in both lists but has not been imported. There is no
      // contact row to hang a crosswalk link on. The next pass after an import
      // picks this up — nothing is lost by waiting.
      return { kind: "not_yet_imported", holderCount };
    }
    const owned = a.ownerContactId ? a : b;
    const unowned = a.ownerContactId ? b : a;
    return {
      kind: "auto_link",
      action: {
        sourceType: unowned.sourceType,
        sourceRecordId: unowned.sourceRecordId,
        // Non-null by the branch above.
        contactId: owned.ownerContactId as string,
      },
      holderCount,
    };
  }

  // ---- the ask band -------------------------------------------------------
  const reason = askReasonFor(group, sources, standaloneContacts.length, twoCrossFamilySources);

  const pairs: AskPair[] = [];
  for (const s of sources) {
    if (s.ownerContactId) continue; // already answered by the crosswalk
    for (const contactId of candidateContactIds) {
      pairs.push({ contactId, sourceType: s.sourceType, sourceRecordId: s.sourceRecordId });
    }
  }

  if (pairs.length === 0) {
    // Nothing unowned, or nothing to link to. Either way there is no question
    // that has an answer, and a queue full of unanswerable questions is worse
    // than an empty one.
    return { kind: "skip", holderCount };
  }

  return { kind: "ask", reason, pairs, holderCount };
}

function askReasonFor(
  group: NameGroup,
  sources: NameSourceMember[],
  standaloneCount: number,
  twoCrossFamilySources: boolean,
): LinkProposalReason {
  if (twoCrossFamilySources && group.hasGenerationalSuffix) {
    return "name_generational_suffix";
  }
  if (
    sources.length === 2 &&
    standaloneCount === 0 &&
    sourceFamily(sources[0].sourceType) === sourceFamily(sources[1].sourceType)
  ) {
    return "name_same_source_family";
  }
  return "name_not_unique";
}

// ---------------------------------------------------------------------------
// THE PASS
// ---------------------------------------------------------------------------

export interface NameAutoLinkSummary {
  /** Name groups examined (only names that yield a first AND a last). */
  groups: number;
  /** Links created by the rule. */
  autoLinked: number;
  /** Groups that qualified but have nothing imported yet. */
  notYetImported: number;
  /** Groups already resolved by the crosswalk. */
  alreadyLinked: number;
  /** Pairs the rule refused to decide and handed to the review queue. */
  asked: number;
  /** Ask pairs dropped because the per-pass cap was reached. */
  askOverflow: number;
  /** Pairs skipped because the user has already said "different people". */
  barredByVerdict: number;
  /** Exact actions taken, for assertions. */
  actions: AutoLinkAction[];
  /** Exact pairs handed to the queue, for assertions. */
  askPairs: Array<AskPair & { reason: LinkProposalReason; holderCount: number; displayName: string }>;
}

/**
 * How many name-derived questions one pass may add to the queue.
 *
 * The founder's table says "ask" for every group of three or more, and on a
 * 1,500-contact address book that is a queue nobody finishes — which would make
 * the button nagging, the one thing the founder asked it not to be. The cap
 * bounds a single pass; nothing is lost, because the pass runs on every sync and
 * groups are visited in a stable key order, so the queue refills as it drains.
 * The overflow is counted and logged rather than silently dropped.
 */
export const NAME_ASK_CAP_PER_PASS = 50;

/**
 * Build the name groups for a user out of every source record and every saved
 * contact, then apply the rule.
 *
 * `onAsk` is a callback rather than a direct write so this module stays free of
 * evidence-building and the queue's schema; the caller owns those.
 */
export function runUniqueNameAutoLink(
  userId: string,
  onAsk?: (pair: AskPair, ctx: { reason: LinkProposalReason; holderCount: number; displayName: string }) => void,
): NameAutoLinkSummary {
  const summary: NameAutoLinkSummary = {
    groups: 0,
    autoLinked: 0,
    notYetImported: 0,
    alreadyLinked: 0,
    asked: 0,
    askOverflow: 0,
    barredByVerdict: 0,
    actions: [],
    askPairs: [],
  };

  const groups = collectNameGroups(userId);
  summary.groups = groups.length;

  for (const group of groups) {
    const decision = evaluateNameGroup(group);

    switch (decision.kind) {
      case "auto_link": {
        const { contactId, sourceType, sourceRecordId } = decision.action;
        // A rejected pair is never linked, by ANY rule. The unique-name rule is
        // a different route to the same pair than the content fallback, and a
        // constraint that only bound one route would not be a constraint.
        if (hasCannotLink(userId, contactId, sourceType, sourceRecordId)) {
          summary.barredByVerdict++;
          break;
        }
        const result = createLink({
          userId,
          contactId,
          sourceType,
          sourceRecordId,
          matchMethod: "unique_name",
        });
        if (result.created) {
          // BACKLOG-2423: a link is also a copy. See contactSourceValues.
          applyLinkedSourceValues(userId, contactId);
          summary.autoLinked++;
          summary.actions.push(decision.action);
          logService.info(
            `[Contacts] auto-linked on a name unique to both sources (${sourceType})`,
            "Contacts",
          );
        }
        break;
      }
      case "not_yet_imported":
        summary.notYetImported++;
        break;
      case "already_linked":
        summary.alreadyLinked++;
        break;
      case "ask": {
        for (const pair of decision.pairs) {
          if (hasCannotLink(userId, pair.contactId, pair.sourceType, pair.sourceRecordId)) {
            summary.barredByVerdict++;
            continue;
          }
          if (summary.asked >= NAME_ASK_CAP_PER_PASS) {
            summary.askOverflow++;
            continue;
          }
          summary.asked++;
          const ctx = {
            reason: decision.reason,
            holderCount: decision.holderCount,
            displayName: group.displayName,
          };
          summary.askPairs.push({ ...pair, ...ctx });
          onAsk?.(pair, ctx);
        }
        break;
      }
      default:
        break;
    }
  }

  if (summary.askOverflow > 0) {
    logService.info(
      `[Contacts] name review queue capped at ${NAME_ASK_CAP_PER_PASS} this pass; ` +
        `${summary.askOverflow} more will be offered on the next sync`,
      "Contacts",
    );
  }

  return summary;
}

/**
 * Every name group in the user's data.
 *
 * Tombstoned contacts are EXCLUDED. A removed contact is not a person competing
 * for a name — counting it would let a deletion permanently block an auto-link
 * that should now succeed. (`removed_at` is the v56 tombstone column; the
 * `IS NULL` also covers databases where the column exists but is never set.)
 */
export function collectNameGroups(userId: string): NameGroup[] {
  const externalRows = dbAll<{
    external_record_id: string;
    source: ExternalContactSource;
    name: string | null;
  }>(
    `SELECT external_record_id, source, name FROM external_contacts
      WHERE user_id = ? AND external_record_id IS NOT NULL AND name IS NOT NULL
      ORDER BY source, external_record_id`,
    [userId],
  );

  const contactRows = dbAll<{ id: string; display_name: string | null }>(
    `SELECT id, display_name FROM contacts
      WHERE user_id = ? AND removed_at IS NULL AND display_name IS NOT NULL
      ORDER BY id`,
    [userId],
  );

  const byKey = new Map<string, NameGroup>();

  const ensure = (norm: NormalizedName, displayName: string): NameGroup => {
    let group = byKey.get(norm.key);
    if (!group) {
      group = {
        key: norm.key,
        displayName,
        hasGenerationalSuffix: norm.hasGenerationalSuffix,
        members: [],
      };
      byKey.set(norm.key, group);
    }
    return group;
  };

  for (const row of externalRows) {
    const norm = normalizeNameKey(row.name);
    if (!norm) continue;
    ensure(norm, row.name ?? norm.key).members.push({
      kind: "source",
      sourceType: row.source,
      sourceRecordId: row.external_record_id,
      name: row.name ?? "",
      ownerContactId: findContactIdBySourceRecord(userId, row.source, row.external_record_id),
    });
  }

  for (const row of contactRows) {
    const norm = normalizeNameKey(row.display_name);
    if (!norm) continue;
    ensure(norm, row.display_name ?? norm.key).members.push({
      kind: "contact",
      contactId: row.id,
      name: row.display_name ?? "",
    });
  }

  // Stable key order so the per-pass cap always takes the same groups first.
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
