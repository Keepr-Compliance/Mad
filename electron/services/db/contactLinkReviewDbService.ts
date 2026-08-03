/**
 * Contact Link Review — the queue and the verdicts (BACKLOG-2410)
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * BACKLOG-2401 taught the linker to WITHHOLD an ambiguous match rather than
 * apply it. Withholding was the correct half. This is the other half: the
 * withheld question has to be asked, and the answer has to be kept.
 *
 * ===========================================================================
 * THE TWO TABLES ARE NOT THE SAME KIND OF THING
 * ===========================================================================
 *   contact_link_proposals — DERIVED. Recomputed by every linking pass.
 *                            Losing it costs one sync.
 *   contact_link_verdicts  — NOT DERIVED. A record of what a human said.
 *                            Losing it is unrecoverable: there is no second
 *                            source of ground truth anywhere in this system,
 *                            and nothing can regenerate a person's opinion.
 *
 * Every function below is written on that asymmetry. Proposals are upserted,
 * ignored on conflict, and freely rewritten. Verdicts are only ever appended.
 *
 * ===========================================================================
 * THE "NEVER PROPOSED AGAIN" GUARANTEE HAS TWO INDEPENDENT LOCKS
 * ===========================================================================
 * 1. `UNIQUE (user_id, contact_id, source_type, source_record_id)` on the
 *    proposal, written with INSERT OR IGNORE. A pair already answered keeps its
 *    resolved row; a re-run cannot flip it back to pending.
 * 2. `getCannotLink` consulted by the linker BEFORE it links or proposes.
 *
 * THEY GUARD DIFFERENT THINGS, and the negative controls measured which:
 *
 *   Lock 1 (the UNIQUE) is the only thing stopping an UNANSWERED question being
 *   appended again on every sync. Removing it fails exactly one test — the queue
 *   grows without bound and the button's count climbs each time a sync runs.
 *
 *   Lock 2 (the verdict consult) is the only thing stopping an ANSWERED pair
 *   being silently LINKED by some other route. Removing it lets a source the
 *   user unlinked by hand come straight back on the next pass.
 *
 * Neither substitutes for the other. Lock 1 governs the queue; lock 2 governs
 * the outcome. A guarantee that only stopped the question being re-asked, while
 * letting the link be silently created, would be worse than no guarantee at all
 * — the user would believe they had been heard.
 *
 * ===========================================================================
 * TWO AXES. WORDS. NO SCORES.
 * ===========================================================================
 * Identity and relationship are separate columns with separate vocabularies
 * (founder decision, 2026-08-02):
 *
 *     identity      same_person | possibly_same_person | different_people
 *     relationship  connected   | possibly_connected   | no_known_connection
 *
 * A buyer and a seller on one deal are `connected` AND `different_people`.
 * There is deliberately no numeric column on either table. `confidence` exists
 * on `contact_source_links` for a future scored matcher; nothing here has an
 * equivalent, because a review queue that shows a user "0.82" has told them
 * nothing they can act on.
 */

import { v4 as uuidv4 } from "uuid";
import { dbAll, dbGet, dbRun } from "./core/dbConnection";
import type { ExternalContactSource } from "./externalContactDbService";

// ---------------------------------------------------------------------------
// VOCABULARY
// ---------------------------------------------------------------------------

/**
 * Reuses the pending/confirmed/rejected idiom already in this codebase
 * (`transactions.detection_status`, models.ts). Deliberately not a new one.
 */
export type LinkProposalStatus = "pending" | "confirmed" | "rejected";

/** Axis 1 — are these the same person? */
export type IdentityAssessment = "same_person" | "possibly_same_person" | "different_people";

/** Axis 2 — are these people connected? Orthogonal to axis 1, never merged into it. */
export type RelationshipAssessment = "connected" | "possibly_connected" | "no_known_connection";

/**
 * Why the question is being asked. The first four mirror
 * `contactSourceLinker.FlagReason` exactly (a withheld content match); the rest
 * come from the unique-exact-name rule.
 *
 * Kept as ONE union rather than two so the queue has a single vocabulary — the
 * user does not care which module declined to guess.
 */
export type LinkProposalReason =
  // --- withheld content matches (BACKLOG-2401) ---
  | "identifier_reassigned"
  | "duplicate_source_record"
  | "ambiguous_identifier"
  | "frozen_audit_contact"
  // --- the unique-exact-name rule (BACKLOG-2410 part 3) ---
  /** 3+ records/contacts carry this name, so a name cannot identify anyone. */
  | "name_not_unique"
  /** Exactly two, but both from the same source family — a within-source dupe. */
  | "name_same_source_family"
  /** Jr / Sr / II / III on either side. The credit-bureau mixed-file pattern. */
  | "name_generational_suffix"
  /** Exactly two, cross-family, but each already belongs to a DIFFERENT saved
   *  contact. Joining them is a merge (BACKLOG-2370), not a link. */
  | "name_two_saved_contacts";

/**
 * The evidence shown to the user, pre-rendered into sentences.
 *
 * BUILT IN THE MAIN PROCESS, NOT THE RENDERER, and stored rather than
 * recomputed. Two reasons, and the second is the important one:
 *   - the sentences need `contacts.display_name`, the source record's name and
 *     the transaction graph, none of which the renderer has;
 *   - a verdict is a LABELLED EXAMPLE, and a label is only usable alongside the
 *     evidence as it stood when the human saw it. Recomputing later under
 *     changed rules would silently relabel history.
 *
 * No field here is a number that could be read as a score.
 */
export interface LinkProposalEvidence {
  /** The one-sentence "why am I being asked this". */
  summary: string;
  /** Supporting statements, each already a full sentence. */
  details: string[];
  /** What to call the saved contact in the UI. */
  contactLabel: string;
  /** What to call the source ("your Outlook contacts"). */
  sourceLabel: string;
  /** The name the source record carries, if any. */
  sourceName: string | null;
}

export interface LinkProposalRow {
  id: string;
  user_id: string;
  contact_id: string;
  source_type: ExternalContactSource;
  source_record_id: string;
  status: LinkProposalStatus;
  reason: LinkProposalReason;
  matched_on: string | null;
  identity_assessment: IdentityAssessment;
  relationship_assessment: RelationshipAssessment;
  cluster_key: string;
  evidence_json: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ProposeLinkInput {
  userId: string;
  contactId: string;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  reason: LinkProposalReason;
  matchedOn?: string | null;
  identityAssessment: IdentityAssessment;
  relationshipAssessment: RelationshipAssessment;
  clusterKey: string;
  evidence: LinkProposalEvidence;
}

export interface LinkVerdictRow {
  id: string;
  user_id: string;
  contact_id: string;
  source_type: ExternalContactSource;
  source_record_id: string;
  identity_verdict: IdentityAssessment;
  relationship_verdict: RelationshipAssessment | null;
  reason: string | null;
  matched_on: string | null;
  evidence_json: string | null;
  decided_at: string;
  decided_by: string;
}

export interface RecordVerdictInput {
  userId: string;
  contactId: string;
  sourceType: ExternalContactSource;
  sourceRecordId: string;
  identityVerdict: IdentityAssessment;
  relationshipVerdict?: RelationshipAssessment | null;
  reason?: string | null;
  matchedOn?: string | null;
  evidence?: LinkProposalEvidence | null;
  decidedBy?: string;
}

const PROPOSAL_COLUMNS = `
  id, user_id, contact_id, source_type, source_record_id, status, reason,
  matched_on, identity_assessment, relationship_assessment, cluster_key,
  evidence_json, created_at, resolved_at
`;

const VERDICT_COLUMNS = `
  id, user_id, contact_id, source_type, source_record_id, identity_verdict,
  relationship_verdict, reason, matched_on, evidence_json, decided_at, decided_by
`;

// ---------------------------------------------------------------------------
// PROPOSALS
// ---------------------------------------------------------------------------

/**
 * Put a pair on the queue, or leave an already-answered one alone.
 *
 * INSERT OR IGNORE against the pair UNIQUE is the whole mechanism. It is chosen
 * over "delete pending rows then re-insert" — the obvious way to keep a derived
 * queue fresh — precisely BECAUSE that pattern cannot distinguish a stale
 * pending row from a resolved one without an extra predicate that is easy to get
 * wrong on a later edit. Here, being answered is structurally protective: the
 * row exists, so the insert is a no-op, so the answer stands.
 *
 * Returns `created: false` for an already-queued or already-answered pair. That
 * is the steady state, not a failure.
 */
export function proposeLink(input: ProposeLinkInput): { created: boolean; id: string | null } {
  if (!input.sourceRecordId || !input.contactId) {
    return { created: false, id: null };
  }

  const id = uuidv4();
  const result = dbRun(
    `INSERT OR IGNORE INTO contact_link_proposals
       (id, user_id, contact_id, source_type, source_record_id, status, reason,
        matched_on, identity_assessment, relationship_assessment, cluster_key, evidence_json)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.contactId,
      input.sourceType,
      input.sourceRecordId,
      input.reason,
      input.matchedOn ?? null,
      input.identityAssessment,
      input.relationshipAssessment,
      input.clusterKey,
      JSON.stringify(input.evidence),
    ],
  );

  return result.changes > 0 ? { created: true, id } : { created: false, id: null };
}

/** Everything still waiting on a human, oldest cluster first. */
export function listPendingProposals(userId: string): LinkProposalRow[] {
  return dbAll<LinkProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM contact_link_proposals
      WHERE user_id = ? AND status = 'pending'
      ORDER BY cluster_key, created_at, id`,
    [userId],
  );
}

/**
 * The number on the button.
 *
 * Counts PAIRS, not clusters. The founder's wording is "Review 12 possible
 * duplicates" — twelve things that might be wrong, however few questions it
 * takes to resolve them.
 */
export function countPendingProposals(userId: string): number {
  const row = dbGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contact_link_proposals
      WHERE user_id = ? AND status = 'pending'`,
    [userId],
  );
  return row?.n ?? 0;
}

export function getProposalById(id: string): LinkProposalRow | null {
  return (
    dbGet<LinkProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM contact_link_proposals WHERE id = ?`, [
      id,
    ]) ?? null
  );
}

/** Every proposal in one cluster that is still pending — the cluster answer's scope. */
export function listPendingProposalsInCluster(
  userId: string,
  clusterKey: string,
): LinkProposalRow[] {
  return dbAll<LinkProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM contact_link_proposals
      WHERE user_id = ? AND cluster_key = ? AND status = 'pending'
      ORDER BY created_at, id`,
    [userId, clusterKey],
  );
}

/**
 * Move a proposal out of the queue.
 *
 * Guarded on `status = 'pending'` so a double-click, a stale renderer, or two
 * windows answering the same question cannot rewrite a decision that has
 * already been made and acted on. Returns whether THIS call was the one that
 * resolved it — the caller uses that to decide whether to perform the side
 * effect (create the link), so the side effect runs exactly once.
 */
export function resolveProposal(id: string, status: Exclude<LinkProposalStatus, "pending">): boolean {
  const result = dbRun(
    `UPDATE contact_link_proposals
        SET status = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'`,
    [status, id],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// VERDICTS — append only
// ---------------------------------------------------------------------------

/**
 * Write down what the human said. Never updates, never deletes.
 *
 * `decidedBy` distinguishes routes to the same conclusion — a queue answer and
 * a provenance unlink both mean "not the same person", but only one of them was
 * a question the user chose to answer, and a calibration set that cannot tell
 * them apart will read an unprompted correction as a prompted one.
 */
export function recordVerdict(input: RecordVerdictInput): string {
  const id = uuidv4();
  dbRun(
    `INSERT INTO contact_link_verdicts
       (id, user_id, contact_id, source_type, source_record_id, identity_verdict,
        relationship_verdict, reason, matched_on, evidence_json, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.contactId,
      input.sourceType,
      input.sourceRecordId,
      input.identityVerdict,
      input.relationshipVerdict ?? null,
      input.reason ?? null,
      input.matchedOn ?? null,
      input.evidence ? JSON.stringify(input.evidence) : null,
      input.decidedBy ?? "user",
    ],
  );
  return id;
}

/**
 * The most recent thing the user said about this exact pair, or null.
 *
 * LATEST WINS, resolved here rather than by a UNIQUE constraint, because a user
 * is allowed to change their mind and the earlier answer is still history worth
 * keeping. `decided_at` has second granularity in SQLite, so `id` breaks ties on
 * two decisions inside the same second — without it the tie-break is rowid order
 * by accident rather than by intent, and "by accident" is how a reversal
 * silently fails to take effect.
 */
export function getLatestVerdict(
  userId: string,
  contactId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): LinkVerdictRow | null {
  return (
    dbGet<LinkVerdictRow>(
      `SELECT ${VERDICT_COLUMNS} FROM contact_link_verdicts
        WHERE user_id = ? AND contact_id = ? AND source_type = ? AND source_record_id = ?
        ORDER BY decided_at DESC, rowid DESC
        LIMIT 1`,
      [userId, contactId, sourceType, sourceRecordId],
    ) ?? null
  );
}

/**
 * Is this pair barred? THE LOAD-BEARING READ OF THIS WHOLE FEATURE.
 *
 * Called by the linker before it links OR proposes. A `different_people` verdict
 * is a hard constraint: no rule, present or future, may create this link or ask
 * about it again. `possibly_same_person` is NOT a bar — it means the user looked
 * and could not tell, which is a reason to stop asking today, not forever.
 */
export function hasCannotLink(
  userId: string,
  contactId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): boolean {
  const verdict = getLatestVerdict(userId, contactId, sourceType, sourceRecordId);
  return verdict?.identity_verdict === "different_people";
}

/** The opposite constraint: the user has asserted these ARE the same person. */
export function hasMustLink(
  userId: string,
  contactId: string,
  sourceType: ExternalContactSource,
  sourceRecordId: string,
): boolean {
  const verdict = getLatestVerdict(userId, contactId, sourceType, sourceRecordId);
  return verdict?.identity_verdict === "same_person";
}

/**
 * The labelled set — every verdict ever recorded, newest first.
 *
 * This is the calibration and regression-test corpus named in the acceptance
 * criteria. It is exposed as a plain read with no filtering so a future
 * threshold-tuning or matcher-regression job takes the whole thing and decides
 * for itself what is relevant; a "useful subset" chosen now would bake in
 * today's idea of which features matter.
 */
export function listVerdicts(userId: string): LinkVerdictRow[] {
  return dbAll<LinkVerdictRow>(
    `SELECT ${VERDICT_COLUMNS} FROM contact_link_verdicts
      WHERE user_id = ?
      ORDER BY decided_at DESC, rowid DESC`,
    [userId],
  );
}

export function countVerdicts(userId: string): number {
  const row = dbGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM contact_link_verdicts WHERE user_id = ?`,
    [userId],
  );
  return row?.n ?? 0;
}

/** Parse an `evidence_json` blob back into its object, tolerating corruption. */
export function parseEvidence(raw: string | null): LinkProposalEvidence | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LinkProposalEvidence;
    return typeof parsed?.summary === "string" ? parsed : null;
  } catch {
    return null;
  }
}
