/**
 * BACKLOG-2856 — stage-and-swap for email Force Re-cache.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `precacheEmails` was incremental only — its own UI copy said "Only downloads
 * emails newer than what is already cached" — so no importer fix could ever
 * reach a row that was already stored. (That sentence is quoted as it stood in
 * August 2026 and is no longer on screen: BACKLOG-3056 made an incremental run
 * also backfill the older span a widened cache window opens up, and rewrote the
 * copy with it. The paragraph below still holds — a backfill reaches mail that
 * was never fetched, never a row that is already stored.) Messages (`importMacOSMessages(userId,
 * forceReimport)`) and contacts (`contacts:forceReimport`) both had a force
 * option; emails had none.
 *
 * WHAT IT REPLACES (BACKLOG-3910a, founder rules 2026-10-11 — these supersede
 * the 2026-08-24 "parity with messages, link loss included" decision):
 *   - every email of the user is replaced, whatever its account, provider, age
 *     or provider id — EXCEPT emails tied to a deal (a transaction link, a
 *     rejected suggestion, or a checklist member on the email or one of its
 *     attachments). Those are never removed, so their links never cascade.
 *   - a kept email on an OPEN deal is refreshed IN PLACE from its fresh copy
 *     (same id, so nothing that points at it changes);
 *   - a kept email on a LOCKED deal (submitted / under review / resubmitted /
 *     approved) is left exactly as it is, and its fresh copy is thrown away;
 *   - all or nothing: if any connected mailbox did not finish its fetch,
 *     nothing is applied.
 *
 * ---------------------------------------------------------------------------
 * WHY STAGE-AND-SWAP, AND WHY NOT THE OLDER SHAPES
 * ---------------------------------------------------------------------------
 * This is BACKLOG-2790's design applied to a second table family. The rebuild is
 * written into EPHEMERAL staging tables with ordinary short transactions; live
 * `emails` stays untouched and readable for the whole run; ONE transaction at
 * the end deletes the force set from live and inserts the staging rows. Cancel,
 * crash, disk-full or a thrown error leaves live exactly as it was BY
 * CONSTRUCTION rather than by rollback.
 *
 * NOT one long transaction across the fetch (BACKLOG-2775's shape). It bought
 * atomicity with a minutes-long transaction on a connection every writer in this
 * process shares, so anything that wrote during the window silently joined it
 * and died with its rollback. An email precache is a NETWORK run over the user's
 * whole cache window — minutes at best — so that window would be even wider here
 * than it was for messages.
 *
 * NOT `ALTER TABLE RENAME`:
 *   - `emails` is SHARED. Other users' rows, and this user's protected rows,
 *     have to survive with their ids.
 *   - SIX tables reference `emails(id)` with ON DELETE CASCADE — attachments,
 *     the participants junction, the transaction-link table and its ignored and
 *     pending-review siblings, and the checklist link members — plus a set of
 *     indexes. Those are bound by NAME; a rename re-points or orphans them.
 *     (Named in prose rather than spelled as identifiers on purpose: the
 *     BACKLOG-2791 one-read-path guard greps raw file text without stripping
 *     comments, so a comment that spells the review table's name reads to it as
 *     a second read path.)
 *   - The cascades are why a kept email is refreshed with an UPDATE on its own
 *     id and never removed and re-inserted: a removal fires them.
 *
 * ---------------------------------------------------------------------------
 * SEPARATE PREFIX FROM THE MESSAGES STAGING, DELIBERATELY
 * ---------------------------------------------------------------------------
 * `forceStaging.sweepStaleStaging` drops EVERY `staging_msgimport_%` table in the
 * database, unscoped, as its way of reclaiming a crashed run's leftovers. If an
 * email force re-cache staged into tables under that prefix, a macOS messages
 * force re-import starting mid-run would drop them — and vice versa. The two
 * features have no reason to share a namespace, so they do not.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import * as crypto from "crypto";
import { UPDATE_EMAIL_IDENTITY_SQL } from "./db/emailSyncSql";
import {
  createStagingTable,
  discardStagedEmails,
  dropStagingTable,
  insertStagedEmails,
  insertStagedParticipants,
  liveEmailIdentityTaken,
  mirrorStagingIndexes,
  refreshLiveEmailFromStaged,
  selectEmailAttachmentFilenames,
  selectStagedIdentities,
  STALE_STAGING_TABLES_SQL,
  type StagedEmailIdentity,
} from "./db/emailStagingSql";
import {
  deleteLiveForceSet as dbDeleteLiveForceSet,
  selectProtectedLiveEmails,
  type EmailForceSet,
  type ProtectedLiveEmail,
} from "./db/emailForceSetSql";
import { LOCKED_SUBMISSION_STATUSES } from "./transactionEligibility";
import {
  checkedStagingTable,
  type StagingTableName,
} from "./db/stagingDdlSql";

/** Prefix every ephemeral table shares, so a crashed run's leftovers are findable. */
export const EMAIL_STAGING_TABLE_PREFIX = "staging_emailrecache_";

/** The providers `precacheEmails` can fetch from; `emails.source` holds exactly these. */
export type EmailForceProvider = "gmail" | "outlook";

/**
 * The force set: whose mail a Force Re-cache replaces. See `db/emailForceSetSql`
 * for the rule (every email of the user except the protected ones) and every
 * statement built from it.
 */
export type { EmailForceSet } from "./db/emailForceSetSql";

/** Build a force set. DATA only — every statement is built in `db/`. */
export function buildEmailForceSet(params: { userId: string }): EmailForceSet {
  return { userId: params.userId };
}

/**
 * Drop every email staging table left behind by a previous run.
 *
 * A process that dies between the rebuild and the swap leaves its staging tables
 * in the database — harmless (nothing else reads them, and the live store is
 * intact precisely because the swap never ran) but not free. The next force run
 * reclaims them.
 *
 * Scoped to the email prefix, so it cannot reach a messages force re-import's
 * staging. Within emails, a second force re-cache cannot overlap a first:
 * `precacheInProgress` refuses a concurrent precache outright (it returns early
 * rather than aborting the running one, which is the difference from the
 * messages path this sweep's counterpart had to reason about).
 */
export function sweepStaleEmailStaging(db: DatabaseType): string[] {
  // The escape character is escaped in the SAME pass as `_`. Escaping only `_`
  // leaves a backslash in the input free to pair with the character after it,
  // which is the incomplete-sanitization shape CodeQL flags
  // (js/incomplete-sanitization). The input is a module constant with neither a
  // backslash nor a `%`, so nothing is exploitable today; it is written
  // correctly anyway because "the input happens to be safe" is a property of a
  // caller, not of this function.
  const escapedPrefix = EMAIL_STAGING_TABLE_PREFIX.replace(/[\\%_]/g, "\\$&");
  const stale = db
    .prepare(STALE_STAGING_TABLES_SQL)
    .all(`${escapedPrefix}%`) as Array<{ name: string }>;

  for (const { name } of stale) {
    // A swept name came from `sqlite_master` filtered on this module's own
    // prefix, so it is checked rather than trusted — the brand is not a
    // formality here, this line is a DROP.
    dropStagingTable(db, checkedStagingTable(name, "email-recache"));
  }
  return stale.map((r) => r.name);
}

/** A resurrection remap aimed at a LIVE row the rebuild deliberately left alone. */
export interface PendingResurrectionRepair {
  readonly existingId: string;
  readonly newExternalId: string;
  readonly messageIdHeader: string | null;
}

/**
 * BACKLOG-1870 attachment metadata for a staged email, held back for the swap.
 *
 * `attachments` is NOT staged, and buffering is why it does not have to be.
 * `upsertEmailAttachmentMetadata` writes a row whose `email_id` references
 * `emails(id)`; during the rebuild that id exists only in the staging table, so
 * writing it live would fail the foreign key (or, with the FK off, plant a row
 * pointing at nothing). Applied inside the swap AFTER the emails are inserted
 * into live, the id is real and the constraint is satisfied.
 *
 * Skipping the metadata instead was the other option and it is worse than it
 * looks: `persistEmailAttachmentMetadata` runs only for rows in `emailsToInsert`,
 * so a later ordinary sync — which inserts nothing, the mail already being
 * cached — would never repopulate it, and attachment filenames would stay
 * unsearchable until the next force re-cache.
 */
export interface PendingAttachmentMeta {
  readonly emailId: string;
  readonly externalEmailId: string;
  readonly filename: string;
  readonly mimeType: string | null;
  readonly fileSizeBytes: number | null;
  /**
   * BACKLOG-2551: already gated by persistEmailAttachmentMetadata. BACKLOG-3187:
   * that gate now yields Gmail's `partId` as well as Outlook's Graph id, so a force
   * re-cache carries identity for BOTH providers rather than for one. Without this
   * field a force re-cache would write NULL for every provider and silently drop
   * its rows out of idx_attachments_email_provider — with nothing red, since the
   * applier just passes the row through.
   */
  readonly providerAttachmentId: string | null;
}

export interface EmailForceStaging {
  readonly userId: string;
  /**
   * BACKLOG-2989 commit A2 fix: these are `StagingTableName`, not `string`.
   *
   * `checkedStagingTable` produces a branded value below, and declaring these
   * two as `string` threw the brand away before anything downstream could
   * demand it — so `emailForceReadView` could interpolate an unchecked name
   * into `FROM "${stagingTable}"` under a docstring claiming it was checked.
   * (That interpolation is GONE as of BACKLOG-3102 PR 2: the name now goes
   * through `db/core/identifierSql.ts`, which refuses any character the staging
   * pattern does not admit. The brand below is still what says WHICH identifier;
   * the builder only says which CHARACTERS.)
   *
   * That is the same widening the compiler caught during A1 at
   * `pairs: Array<[live: string, staging: string]>`, one commit later. The
   * brand only holds if EVERY declaration between construction and use keeps
   * it; branding the parameters alone is not enough.
   */
  readonly emailsTable: StagingTableName;
  readonly participantsTable: StagingTableName;
  /** Whose mail the swap replaces; the run's dedup reads hide all of it. */
  readonly forceSet: EmailForceSet;
  /**
   * Resurrection remaps (BACKLOG-1769) that target rows in the REAL `emails`
   * table rather than in staging. BACKLOG-3910a: the read view hides every live
   * row of this user, so on a force run nothing can match and this stays empty;
   * the path is kept for the shape it shares with the incremental sync.
   * Buffered and applied as the swap's last step, mirroring
   * `forceStaging.messageIdRepairs`: today that UPDATE would run inside the
   * transaction and become visible only at COMMIT, and buffering reproduces
   * exactly that visibility while keeping the live table untouched for the
   * length of the rebuild.
   */
  readonly resurrectionRepairs: PendingResurrectionRepair[];
  /** BACKLOG-1870 metadata for staged rows, applied inside the swap (see the type). */
  readonly attachmentMeta: PendingAttachmentMeta[];
  /** Drop both tables. Idempotent; safe to call on any exit path. */
  drop(): void;
}

/**
 * What the swap did. The three "kept" buckets partition the protected emails:
 *
 *   emailsRefreshed    protected, on no locked deal, paired with a fresh copy
 *                      and refreshed in place.
 *   emailsKeptLocked   protected AND part of a locked deal's record — whether
 *                      or not a fresh copy arrived. Never changed.
 *   emailsKeptNoCopy   protected, on no locked deal, and no fresh copy arrived
 *                      (outside the window, from a mailbox not connected, or a
 *                      losing duplicate in the pairing). Kept unchanged.
 *
 * `emailsDeleted` counts the unprotected rows removed (it includes rows whose
 * fresh copy is among `emailsInserted`).
 */
export interface EmailForceSwapCounts {
  emailsDeleted: number;
  emailsInserted: number;
  emailsRefreshed: number;
  emailsKeptLocked: number;
  emailsKeptNoCopy: number;
  participantsInserted: number;
  resurrectionsRepaired: number;
  attachmentMetaApplied: number;
}

export const emailForceStagingLifecycle = {
  /**
   * Create this run's staging tables. Cheap: two `CREATE TABLE`s and a handful of
   * index definitions, no data copied — the rebuild fills them from the provider.
   *
   * `email_participants` is staged alongside `emails` because the insert path
   * writes junction rows in the SAME transaction as the email row
   * (`emailSyncService` prepares `insertParticipantStmt` next to `insertStmt`).
   * Staging only `emails` would silently drop every participant row of a
   * re-cached message, which is what `email_participants` powers: participant
   * search and contact linking.
   */
  create(
    db: DatabaseType,
    args: { userId: string; forceSet: EmailForceSet },
  ): EmailForceStaging {
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    // Checked at CONSTRUCTION, not at use: the branded type then travels with
    // the name, so every function that splices it into DDL demands the checked
    // form and the compiler refuses an unchecked one.
    const emailsTable = checkedStagingTable(
      `${EMAIL_STAGING_TABLE_PREFIX}${token}_emails`,
      "email-recache",
    );
    const participantsTable = checkedStagingTable(
      `${EMAIL_STAGING_TABLE_PREFIX}${token}_participants`,
      "email-recache",
    );

    const pairs: Array<[live: string, staging: StagingTableName]> = [
      ["emails", emailsTable],
      ["email_participants", participantsTable],
    ];

    for (const [live, staging] of pairs) {
      // Derived from `sqlite_master` rather than `CREATE TABLE … AS SELECT * …
      // WHERE 0`, for the reason `forceStaging.deriveStagingTableDdl` documents:
      // the insert names a subset of the columns and lets the table supply the
      // rest from its DEFAULTs (`has_attachments INTEGER DEFAULT 0`, …).
      // `AS SELECT` copies names and types and drops every default, so staging
      // would store NULL where live stores 0 — and the swap would carry those
      // NULLs into live. Deriving the real DDL also means a future migration's
      // new column arrives in staging on its own.
      createStagingTable(db, live, staging);
      mirrorStagingIndexes(db, live, staging, `${EMAIL_STAGING_TABLE_PREFIX}${token}_`);
    }

    let dropped = false;
    return {
      userId: args.userId,
      emailsTable,
      participantsTable,
      forceSet: args.forceSet,
      resurrectionRepairs: [],
      attachmentMeta: [],
      drop(): void {
        if (dropped) return;
        dropped = true;
        dropStagingTable(db, participantsTable);
        dropStagingTable(db, emailsTable);
      },
    };
  },
};

/**
 * The connected providers that did NOT finish a full rebuild (BACKLOG-3910a,
 * SR decision 5: apply nothing).
 *
 * The removal is no longer per mailbox — it is every unprotected email of the
 * user — so applying a run where one mailbox stopped part-way would remove that
 * mailbox's mail and put nothing back. Any entry here means: do not swap.
 */
export function providersNotRebuilt(
  connectedProviders: readonly EmailForceProvider[],
  rebuiltProviders: readonly EmailForceProvider[],
): EmailForceProvider[] {
  if (connectedProviders.length === 0) return [];
  return connectedProviders.filter((p) => !rebuiltProviders.includes(p));
}

/** One protected live email matched to its fresh staged copy. */
export interface EmailForcePair {
  readonly kept: ProtectedLiveEmail;
  readonly staged: StagedEmailIdentity;
}

export interface EmailForcePairing {
  /** Pairs whose kept email is on no locked deal — refreshed in place. */
  readonly open: EmailForcePair[];
  /** Pairs whose kept email is on a locked deal — the copy is discarded. */
  readonly frozen: EmailForcePair[];
  /** Protected emails no fresh copy was paired with. */
  readonly unpaired: ProtectedLiveEmail[];
}

/**
 * Pair fresh staged copies with protected live emails, 1:1 and deterministic
 * (BACKLOG-3910a, SR S2).
 *
 *   pass 1  same provider id AND same source; across DIFFERENT accounts the
 *           Message-ID must also agree where both carry one;
 *   pass 2  same Message-ID, among what pass 1 left.
 *
 * USER-scoped, not account-scoped: `account_id` is `oauth_tokens.id`, so a
 * reconnected mailbox — or a legacy row with NULL account — gives the fresh
 * copy a different account. An account-scoped match would leave the kept row
 * AND insert the copy beside it: a silent duplicate.
 *
 * When two kept emails match one copy, the tiebreak is: same account_id, then
 * same source, then the oldest `created_at` (then id, for determinism). The
 * loser is untouched — never merged — and counted as kept with no copy.
 */
export function pairStagedWithProtected(
  staged: readonly StagedEmailIdentity[],
  kept: readonly ProtectedLiveEmail[],
): EmailForcePairing {
  const pairedKept = new Set<string>();
  const pairedStaged = new Set<string>();
  const pairs: EmailForcePair[] = [];

  const rank = (s: StagedEmailIdentity, k: ProtectedLiveEmail): Array<string | number> => [
    s.account_id !== null && s.account_id === k.account_id ? 0 : 1,
    s.source !== null && s.source === k.source ? 0 : 1,
    k.created_at ?? "\uffff",
    k.id,
    s.id,
  ];
  const compare = (x: Array<string | number>, y: Array<string | number>): number => {
    for (let i = 0; i < x.length; i++) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  };
  const assign = (edges: EmailForcePair[]): void => {
    const ranked = edges
      .map((e) => ({ e, r: rank(e.staged, e.kept) }))
      .sort((x, y) => compare(x.r, y.r));
    for (const { e } of ranked) {
      if (pairedKept.has(e.kept.id) || pairedStaged.has(e.staged.id)) continue;
      pairedKept.add(e.kept.id);
      pairedStaged.add(e.staged.id);
      pairs.push(e);
    }
  };

  const byExternal = new Map<string, ProtectedLiveEmail[]>();
  const byHeader = new Map<string, ProtectedLiveEmail[]>();
  for (const k of kept) {
    if (k.external_id !== null) {
      byExternal.set(k.external_id, [...(byExternal.get(k.external_id) ?? []), k]);
    }
    if (k.message_id_header !== null) {
      byHeader.set(k.message_id_header, [...(byHeader.get(k.message_id_header) ?? []), k]);
    }
  }

  const pass1: EmailForcePair[] = [];
  for (const s of staged) {
    if (s.external_id === null) continue;
    for (const k of byExternal.get(s.external_id) ?? []) {
      const sameSource = s.source !== null && s.source === k.source;
      // Same account + same provider id is ONE identity by the partial unique
      // index, so it pairs whatever the Message-ID says: refusing it would
      // leave the copy unpaired and its insert would hit that index and roll
      // the whole re-cache back (measured on the 3475 fixture, whose kept row
      // carries a different Message-ID). Across accounts the Message-ID must
      // agree where both carry one (SR S2).
      const sameAccount = s.account_id !== null && s.account_id === k.account_id;
      const headersAgree =
        sameAccount ||
        s.message_id_header === null ||
        k.message_id_header === null ||
        s.message_id_header === k.message_id_header;
      if (sameSource && headersAgree) pass1.push({ kept: k, staged: s });
    }
  }
  assign(pass1);

  const pass2: EmailForcePair[] = [];
  for (const s of staged) {
    if (s.message_id_header === null || pairedStaged.has(s.id)) continue;
    for (const k of byHeader.get(s.message_id_header) ?? []) {
      if (!pairedKept.has(k.id)) pass2.push({ kept: k, staged: s });
    }
  }
  assign(pass2);

  return {
    open: pairs.filter((p) => p.kept.frozen !== 1),
    frozen: pairs.filter((p) => p.kept.frozen === 1),
    unpaired: kept.filter((k) => !pairedKept.has(k.id)),
  };
}

/**
 * The swap, as named steps.
 *
 * Separate and individually addressable ON PURPOSE: the property that matters is
 * that all of them happen together or none of them does, and a control can only
 * demonstrate that by interrupting BETWEEN them.
 */
export const emailForceSwapSteps = {
  /**
   * The protected emails and their frozen flag. Called INSIDE the swap
   * transaction, so no link can be added or removed between this read and the
   * removal that relies on it.
   */
  readProtected(db: DatabaseType, staging: EmailForceStaging): ProtectedLiveEmail[] {
    return selectProtectedLiveEmails(db, staging.forceSet, LOCKED_SUBMISSION_STATUSES);
  },

  /** Pair the fresh copies with the protected emails (see `pairStagedWithProtected`). */
  pair(
    db: DatabaseType,
    staging: EmailForceStaging,
    kept: readonly ProtectedLiveEmail[],
  ): EmailForcePairing {
    return pairStagedWithProtected(selectStagedIdentities(db, staging.emailsTable), kept);
  },

  /**
   * A locked deal's email is left exactly as it is: its fresh copy, the copy's
   * participants and its buffered attachment details are all thrown away.
   */
  discardFrozenCopies(
    db: DatabaseType,
    staging: EmailForceStaging,
    pairing: EmailForcePairing,
  ): number {
    const stagedIds = pairing.frozen.map((p) => p.staged.id);
    const discarded = new Set(stagedIds);
    for (let i = staging.attachmentMeta.length - 1; i >= 0; i--) {
      if (discarded.has(staging.attachmentMeta[i].emailId)) staging.attachmentMeta.splice(i, 1);
    }
    discardStagedEmails(db, staging.emailsTable, staging.participantsTable, stagedIds);
    return stagedIds.length;
  },

  /**
   * Remove every UNPROTECTED email of the user. Runs BEFORE the refresh, so a
   * refreshed email's new identity cannot collide with an unprotected copy of
   * the same message.
   */
  deleteLiveForceSet(db: DatabaseType, staging: EmailForceStaging): number {
    return dbDeleteLiveForceSet(db, staging.forceSet);
  },

  /**
   * Refresh each open pair in place, then re-point its buffered attachment
   * details at the live id.
   *
   * The identity columns are written only when no other live email holds them
   * (a collision must not fail the re-cache); otherwise content only.
   *
   * SR S3: when the pair's account changes (a reconnected mailbox), the kept
   * attachment rows carry the OLD provider attachment id, so the fresh details
   * would miss them and insert a same-named duplicate. For those pairs a fresh
   * detail whose filename the kept email already has is matched by filename.
   * Narrow to account-changed pairs on purpose: filename alone is not an
   * identity (`image001.png` repeats), which is why the normal path keys on the
   * provider id.
   */
  refreshKept(db: DatabaseType, staging: EmailForceStaging, pairing: EmailForcePairing): number {
    for (const { kept, staged } of pairing.open) {
      const writeIdentity = !liveEmailIdentityTaken(db, kept.id, {
        accountId: staged.account_id,
        externalId: staged.external_id,
        messageIdHeader: staged.message_id_header,
      });
      refreshLiveEmailFromStaged(db, staging.emailsTable, staging.participantsTable, {
        liveId: kept.id,
        stagedId: staged.id,
        writeIdentity,
        previousThreadId: kept.thread_id,
      });

      const accountChanged = staged.account_id !== kept.account_id;
      const keptFilenames = accountChanged
        ? new Set(selectEmailAttachmentFilenames(db, kept.id))
        : new Set<string>();
      for (let i = 0; i < staging.attachmentMeta.length; i++) {
        const meta = staging.attachmentMeta[i];
        if (meta.emailId !== staged.id) continue;
        staging.attachmentMeta[i] = {
          ...meta,
          emailId: kept.id,
          providerAttachmentId: keptFilenames.has(meta.filename) ? null : meta.providerAttachmentId,
        };
      }
    }
    return pairing.open.length;
  },

  /**
   * Emails before participants, so `email_participants.email_id`'s foreign key
   * finds its row. What is left in staging now is fresh mail with no kept
   * counterpart.
   *
   * Plain `INSERT`, not `INSERT OR IGNORE`: a uniqueness conflict means the
   * pairing and the rebuild disagree, and throwing aborts the whole swap and
   * leaves the user's store exactly as it was.
   */
  insertFromStaging(
    db: DatabaseType,
    staging: EmailForceStaging,
  ): { emailsInserted: number; participantsInserted: number } {
    return {
      emailsInserted: insertStagedEmails(db, staging.emailsTable),
      participantsInserted: insertStagedParticipants(db, staging.participantsTable),
    };
  },

  /** BACKLOG-1769 resurrection remaps against live rows the rebuild left alone. */
  applyResurrectionRepairs(db: DatabaseType, staging: EmailForceStaging): number {
    if (staging.resurrectionRepairs.length === 0) return 0;
    // The same statement the incremental sync path uses — one const in db/.
    const update = db.prepare(UPDATE_EMAIL_IDENTITY_SQL);
    let repaired = 0;
    for (const repair of staging.resurrectionRepairs) {
      repaired += update.run(repair.newExternalId, repair.messageIdHeader, repair.existingId).changes;
    }
    return repaired;
  },

  /**
   * BACKLOG-1870 metadata for the rows just inserted or refreshed. The writer
   * adds missing rows and fills NULL details only — it never overwrites or
   * removes an existing attachment row, so a kept email's stored files stay.
   *
   * The writer is injected rather than imported, to avoid an import cycle with
   * `databaseService`.
   */
  applyAttachmentMeta(
    staging: EmailForceStaging,
    persist: (meta: PendingAttachmentMeta) => void,
  ): number {
    let applied = 0;
    for (const meta of staging.attachmentMeta) {
      persist(meta);
      applied++;
    }
    return applied;
  },
};

/**
 * Put the rebuild in place.
 *
 * ONE synchronous `db.transaction()` callback, containing no `await`. That is
 * the whole safety argument: better-sqlite3 is synchronous on a single shared
 * connection, so while this callback runs no other code in this process runs.
 * Nothing can observe the half-swapped state.
 *
 * The protected set is read INSIDE the transaction (step 1), so there is no gap
 * between deciding what to keep and removing the rest.
 *
 * Other writers during the run: `syncTransactionEmails` writes live `emails` and
 * is not behind `precacheInProgress`. An unprotected row it wrote mid-run is
 * removed here; a protected one is kept and paired like any other.
 *
 * If any step throws, the transaction rolls back and the user's store is the
 * one they started with.
 */
export function swapEmailStagingIntoLive(
  db: DatabaseType,
  staging: EmailForceStaging,
  hooks: { persistAttachmentMeta: (meta: PendingAttachmentMeta) => void },
): EmailForceSwapCounts {
  const swap = db.transaction((): EmailForceSwapCounts => {
    const kept = emailForceSwapSteps.readProtected(db, staging);
    const pairing = emailForceSwapSteps.pair(db, staging, kept);
    emailForceSwapSteps.discardFrozenCopies(db, staging, pairing);
    const emailsDeleted = emailForceSwapSteps.deleteLiveForceSet(db, staging);
    const emailsRefreshed = emailForceSwapSteps.refreshKept(db, staging, pairing);
    const inserted = emailForceSwapSteps.insertFromStaging(db, staging);
    const resurrectionsRepaired = emailForceSwapSteps.applyResurrectionRepairs(db, staging);
    const attachmentMetaApplied = emailForceSwapSteps.applyAttachmentMeta(
      staging,
      hooks.persistAttachmentMeta,
    );
    const emailsKeptLocked = kept.filter((k) => k.frozen === 1).length;
    return {
      emailsDeleted,
      ...inserted,
      emailsRefreshed,
      emailsKeptLocked,
      emailsKeptNoCopy: pairing.unpaired.filter((k) => k.frozen !== 1).length,
      resurrectionsRepaired,
      attachmentMetaApplied,
    };
  });

  return swap();
}
