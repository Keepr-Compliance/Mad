/**
 * BACKLOG-2856 — stage-and-swap for email Force Re-cache.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `precacheEmails` was incremental only — its own UI copy said "Only downloads
 * emails newer than what is already cached" — so no importer fix could ever
 * reach a row that was already stored. Messages (`importMacOSMessages(userId,
 * forceReimport)`) and contacts (`contacts:forceReimport`) both had a force
 * option; emails had none.
 *
 * Founder decision 2026-08-24: build it to PARITY with the messages force
 * re-import, link loss included. "I want the mental model to not be complicated
 * so the functionality of the force button on the msg should be the same as the
 * emails." Re-pointing `communications.email_id` through the stable
 * `message_id_header` is technically possible and is deliberately NOT done —
 * one force button, one behaviour, no per-source exception to remember.
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
 * NOT `ALTER TABLE RENAME`. All three of `forceStaging.ts`'s reasons apply:
 *   - `emails` is SHARED. The force set is a strict subset — other users' rows,
 *     rows with a NULL `external_id`, rows from a provider this run cannot
 *     rebuild, and rows older than the cache window all have to survive.
 *   - FIVE tables reference `emails(id)` with ON DELETE CASCADE — attachments,
 *     the participants junction, the transaction-link table and its ignored and
 *     pending-review siblings — plus a set of indexes. Those are bound by NAME;
 *     a rename re-points or orphans them. (Named in prose rather than spelled
 *     as identifiers on purpose: the BACKLOG-2791 one-read-path guard greps raw
 *     file text without stripping comments, so a doc comment that spells the
 *     review table's name reads to it as a second read path. That guard is
 *     over-broad — filed separately — but a comment is not worth breaking CI
 *     over, and relaxing a guard from inside the PR it blocks is exactly the
 *     move that guard exists to prevent.)
 *   - Those cascades are the POINT here, not an obstacle: deleting the force set
 *     with an ordinary DELETE is what makes link loss happen exactly as it does
 *     for messages, which is the parity the founder asked for.
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
import { forceReadView } from "./macOSMessagesImportService/forceStaging";
import {
  deriveStagingIndexDdl,
  deriveStagingTableDdl,
  checkedStagingTable,
  type StagingTableName,
  emailTableDdl as tableDdl,
} from "./db/stagingDdlSql";

/** Prefix every ephemeral table shares, so a crashed run's leftovers are findable. */
export const EMAIL_STAGING_TABLE_PREFIX = "staging_emailrecache_";

/** The providers `precacheEmails` can fetch from; `emails.source` holds exactly these. */
export type EmailForceProvider = "gmail" | "outlook";

const ALLOWED_PROVIDERS: readonly EmailForceProvider[] = ["gmail", "outlook"];

/**
 * The force set, as ONE definition: the rows an email Force Re-cache replaces.
 *
 * Both the swap's DELETE and the rebuild's "what will still be there" reads are
 * built from this. Two spellings would be two different answers to "what does a
 * force re-cache replace", and the drift would be silent — the swap would delete
 * rows the rebuild assumed were still there, or keep rows it assumed were gone.
 *
 * ---------------------------------------------------------------------------
 * SCOPE — the BACKLOG-2796 rule, applied to emails
 * ---------------------------------------------------------------------------
 * The scope answers one question: what can THIS run put back? Anything it cannot
 * re-fetch must survive, because deleting it would be a pure loss with nothing
 * to replace it. That is the lesson 2796 paid for on the messages side, where an
 * unscoped force set deleted every row the user had from any source and rebuilt
 * only what chat.db could supply.
 *
 *   - `external_id IS NOT NULL` — provider-sourced rows only, matching the
 *     messages predicate. A row with no provider id is not something a provider
 *     fetch can reproduce.
 *   - `source IN (…)` — ALLOW-LIST of the providers that actually completed a
 *     fetch on this run. Not "every provider the schema allows": if only Gmail
 *     is connected, or Outlook is connected but its token has expired, the
 *     Outlook rows cannot be rebuilt and so must not be deleted. A user who
 *     disconnected Outlook and clicks Re-cache must not lose their Outlook mail.
 *   - `sent_at >= @cacheSince` — the fetch is bounded by the user's cache-window
 *     preference (`computeEmailCacheSinceDate`). Rows older than that window are
 *     outside what this run downloads, so they are scoped OUT rather than
 *     silently trimmed off the back of the corpus.
 *
 * Allow-list rather than deny-list, deliberately, for the same reason as 2796:
 * listing the sources to SPARE re-plants the bug the moment somebody adds a
 * third one. An unrecognised row survives by default, which is the only
 * defensible default for a predicate whose failure mode is deleting the user's
 * mail.
 *
 * Parameters are POSITIONAL (`?`) rather than named, because every caller
 * splices this into a query that already binds positionally through `dbAll`.
 * `params` is returned alongside the SQL so the two cannot drift apart, and the
 * provider list is spliced as quoted literals — safe because every element is
 * checked against `ALLOWED_PROVIDERS` first, and a value that fails that check
 * throws rather than reaching the SQL.
 */
export interface EmailForceSetPredicate {
  /** The predicate SQL, with one `?` for userId and one for the cache-window floor. */
  readonly sql: string;
  /** `NOT (sql)`, NULL-safe — the rows the force set leaves in place. */
  readonly survivingSql: string;
  /** Positional bindings for either predicate, in order of appearance. */
  readonly params: readonly string[];
}

export function buildEmailForceSet(params: {
  userId: string;
  providers: readonly EmailForceProvider[];
  cacheSinceIso: string;
}): EmailForceSetPredicate {
  const { userId, providers, cacheSinceIso } = params;

  for (const provider of providers) {
    if (!ALLOWED_PROVIDERS.includes(provider)) {
      throw new Error(`Refusing to build an email force set for unknown source "${provider}"`);
    }
  }
  if (providers.length === 0) {
    throw new Error("Refusing to build an email force set with no rebuildable provider");
  }

  const sourceList = providers.map((p) => `'${p}'`).join(", ");
  const sql =
    `user_id = ? AND external_id IS NOT NULL ` +
    `AND source IN (${sourceList}) ` +
    `AND sent_at >= ?`;

  return {
    sql,
    // NULL-safe by hand, exactly as `SURVIVING_MESSAGES` is. `source` is nullable
    // past its CHECK constraint and `sent_at` is nullable outright, so the force
    // predicate CAN evaluate to NULL. For such a row a plain `NOT (…)` is NULL —
    // the row would survive the DELETE (correct: a DELETE removes a row only
    // when its WHERE is TRUE) and then drop out of the rebuild's survivor read
    // (wrong), which is exactly how a surviving row stops being deduplicated
    // against and gets staged a second time. COALESCE spells out what "survived"
    // means: the force set was not TRUE.
    survivingSql: `COALESCE(${sql}, 0) = 0`,
    params: [userId, cacheSinceIso],
  };
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
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`)
    .all(`${escapedPrefix}%`) as Array<{ name: string }>;

  for (const { name } of stale) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
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
}

export interface EmailForceStaging {
  readonly userId: string;
  readonly emailsTable: string;
  readonly participantsTable: string;
  /**
   * The force-set predicate; the swap deletes exactly it.
   *
   * Mutable because the set can only be NARROWED between the rebuild and the
   * swap — see `restrictForceSetToRebuiltProviders`. It starts as the optimistic
   * set (every connected provider) so the rebuild's dedup reads treat those rows
   * as "about to be replaced" and stage their re-fetched copies.
   */
  forceSet: EmailForceSetPredicate;
  /**
   * Resurrection remaps (BACKLOG-1769) that target rows in the REAL `emails`
   * table rather than in staging — i.e. SURVIVORS, since a force-set row is no
   * longer visible to the dedup read and comes back as a plain staged insert.
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

export interface EmailForceSwapCounts {
  emailsDeleted: number;
  emailsInserted: number;
  participantsInserted: number;
  resurrectionsRepaired: number;
  attachmentMetaApplied: number;
}

/** The columns of a live table, in declaration order, quoted for reuse on both sides of the swap. */
function columnList(db: DatabaseType, table: string): string {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length === 0) {
    throw new Error(`Cannot swap: table "${table}" has no columns`);
  }
  return columns.map((c) => `"${c.name}"`).join(", ");
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
    args: { userId: string; forceSet: EmailForceSetPredicate },
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
      db.exec(deriveStagingTableDdl(tableDdl(db, live), live, staging));

      const indexes = db
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
        )
        .all(live) as Array<{ name: string; sql: string }>;

      for (const index of indexes) {
        db.exec(
          deriveStagingIndexDdl(
            index.sql,
            index.name,
            live,
            staging,
            checkedStagingTable(
              `${EMAIL_STAGING_TABLE_PREFIX}${token}_${index.name}`,
              "email-recache",
            ),
          ),
        );
      }
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
        db.exec(`DROP TABLE IF EXISTS "${participantsTable}"`);
        db.exec(`DROP TABLE IF EXISTS "${emailsTable}"`);
      },
    };
  },
};

/**
 * A read that must see what the live table WOULD look like at this point in a
 * force run: everything the swap will not delete, plus everything this run has
 * staged so far.
 *
 * This is the equivalence that makes the rebuild behaviour-preserving, and
 * getting it wrong is the catastrophic path for this feature — not a subtle one.
 * `fetchStoreAndDedup` decides what to insert by asking live `emails` which
 * `external_id`s and `message_id_header`s it already holds. Under a force run
 * live still holds the ENTIRE force set (that is the point of staging), so every
 * re-fetched row would match, be classified an already-cached duplicate, and
 * never be staged. Staging would finish empty and the swap would delete the
 * user's whole corpus and put nothing back.
 *
 * Reading only staging is equally wrong in the other direction: it would lose
 * the survivors, so a row this run is not replacing would stop being deduplicated
 * against and be inserted a second time.
 *
 * Columns are listed explicitly — `SELECT *` here would drag `body_html` for
 * every row of a large mailbox through a query that wants two columns.
 */
export function emailForceReadView(
  staging: EmailForceStaging,
  columns: string,
): { sql: string; params: readonly string[] } {
  return {
    sql: forceReadView("emails", staging.emailsTable, staging.forceSet.survivingSql, columns),
    params: staging.forceSet.params,
  };
}

/**
 * Narrow the force set to the providers that actually finished a rebuild, and
 * throw away the staged rows of the ones that did not.
 *
 * A provider can drop out after the rebuild has already staged some of its mail:
 * an expired token, a network failure, or — the case that matters most — a
 * partial fetch, where the inbox round succeeded and the all-folders round did
 * not. Deleting a provider's live rows when this run holds only PART of its mail
 * would trim the corpus to whatever happened to arrive before the failure, which
 * is a silent data loss dressed as a successful re-cache.
 *
 * NARROWING ONLY, and the direction is what makes this safe. The rebuild's dedup
 * reads ran against the optimistic predicate, i.e. they assumed those rows would
 * be gone. Narrowing means MORE rows survive than the rebuild assumed, so the
 * one hazard is a staged row colliding with the survivor it was meant to
 * replace — which is why the staged rows of a dropped provider are deleted here
 * rather than left for the swap's plain INSERT to throw on. Widening would be
 * the opposite and is never done: it would delete rows the rebuild never staged
 * a replacement for.
 *
 * Returns `null` when nothing can be rebuilt, which the caller must treat as
 * "do not swap at all" — with no provider rebuilt there is nothing to put back,
 * and a swap would be a pure deletion.
 */
export function restrictForceSetToRebuiltProviders(
  db: DatabaseType,
  staging: EmailForceStaging,
  rebuiltProviders: readonly EmailForceProvider[],
  cacheSinceIso: string,
): EmailForceSetPredicate | null {
  if (rebuiltProviders.length === 0) return null;

  const dropped = ALLOWED_PROVIDERS.filter((p) => !rebuiltProviders.includes(p));
  for (const provider of dropped) {
    // The buffered attachment metadata points at staged email ids that are about
    // to stop existing. Left in place it would reach the swap and fail the
    // `REFERENCES emails(id)` foreign key, aborting a re-cache that is otherwise
    // perfectly valid for the provider that DID succeed.
    const orphanedIds = new Set(
      (
        db
          .prepare(`SELECT id FROM "${staging.emailsTable}" WHERE source = ?`)
          .all(provider) as Array<{ id: string }>
      ).map((r) => r.id),
    );
    for (let i = staging.attachmentMeta.length - 1; i >= 0; i--) {
      if (orphanedIds.has(staging.attachmentMeta[i].emailId)) {
        staging.attachmentMeta.splice(i, 1);
      }
    }

    // Participants first: they reference the staged email rows.
    db.prepare(
      `DELETE FROM "${staging.participantsTable}" WHERE email_id IN ` +
        `(SELECT id FROM "${staging.emailsTable}" WHERE source = ?)`,
    ).run(provider);
    db.prepare(`DELETE FROM "${staging.emailsTable}" WHERE source = ?`).run(provider);
  }

  const restricted = buildEmailForceSet({
    userId: staging.userId,
    providers: rebuiltProviders,
    cacheSinceIso,
  });
  staging.forceSet = restricted;
  return restricted;
}

/**
 * The swap, as named steps.
 *
 * Separate and individually addressable ON PURPOSE: the property that matters is
 * that all of them happen together or none of them does, and a control can only
 * demonstrate that by interrupting BETWEEN them. Injecting a failure at the seam
 * must leave the store untouched; running the same steps in separate
 * transactions must leave it emptied. That is the mutation that proves the
 * atomicity claim, and it needs the seam to exist.
 */
export const emailForceSwapSteps = {
  /**
   * Delete the force set from live.
   *
   * An ordinary DELETE, so every ON DELETE CASCADE fires: the participants
   * junction, attachments, and the three link tables (transaction links, plus
   * their ignored and pending-review siblings — see the header for why these are
   * named in prose). Losing those links is the AGREED behaviour (founder,
   * 2026-08-24: parity with messages), not an accident, and it is why the
   * confirmation dialog has to say so before the run starts.
   */
  deleteLiveForceSet(db: DatabaseType, staging: EmailForceStaging): number {
    return db
      .prepare(`DELETE FROM emails WHERE ${staging.forceSet.sql}`)
      .run(...staging.forceSet.params).changes;
  },

  /**
   * Emails before participants, so `email_participants.email_id`'s foreign key
   * finds its row.
   *
   * Plain `INSERT`, not `INSERT OR IGNORE`. A uniqueness conflict here means the
   * force set and the rebuild disagree about what a force re-cache replaces, and
   * throwing is the right answer to a disagreement: it aborts the whole swap and
   * leaves the user's store exactly as it was, which `OR IGNORE` would turn into
   * a silent partial re-cache.
   *
   * The rebuild already avoids staging a survivor's `external_id` — the dedup
   * read unions the survivors in, so a survivor's id is skipped rather than
   * staged. The residue is a mid-run write from `syncTransactionEmails`, which
   * also writes `emails` and is not behind `precacheInProgress`. That is left to
   * throw deliberately rather than yielding like the messages path does: the
   * messages yield exists because TWO other services (Android, iPhone) write
   * into that id space from inbound handlers nothing in this process controls,
   * whereas an email row landing inside this user's force set mid-run is the
   * same app's own transaction sync, is rare, and rolling the whole swap back is
   * the safe outcome — live is untouched and the user can re-run.
   */
  insertFromStaging(
    db: DatabaseType,
    staging: EmailForceStaging,
  ): { emailsInserted: number; participantsInserted: number } {
    const emailColumns = columnList(db, "emails");
    const participantColumns = columnList(db, "email_participants");

    const emails = db
      .prepare(
        `INSERT INTO emails (${emailColumns}) ` +
          `SELECT ${emailColumns} FROM "${staging.emailsTable}"`,
      )
      .run();
    const participants = db
      .prepare(
        `INSERT INTO email_participants (${participantColumns}) ` +
          `SELECT ${participantColumns} FROM "${staging.participantsTable}"`,
      )
      .run();

    return {
      emailsInserted: emails.changes,
      participantsInserted: participants.changes,
    };
  },

  /** BACKLOG-1769 resurrection remaps against live rows the rebuild left alone. */
  applyResurrectionRepairs(db: DatabaseType, staging: EmailForceStaging): number {
    if (staging.resurrectionRepairs.length === 0) return 0;
    const update = db.prepare(
      `UPDATE emails SET external_id = ?, message_id_header = COALESCE(message_id_header, ?) WHERE id = ?`,
    );
    let repaired = 0;
    for (const repair of staging.resurrectionRepairs) {
      repaired += update.run(repair.newExternalId, repair.messageIdHeader, repair.existingId).changes;
    }
    return repaired;
  },

  /**
   * BACKLOG-1870 metadata for the rows just inserted into live.
   *
   * The writer is injected rather than imported. `emailForceStaging` is reached
   * from `emailSyncService`, which already imports `databaseService`; importing
   * it back the other way to reach one upsert would close a cycle for no gain,
   * and passing the function keeps this file testable against a plain spy.
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
 * ONE synchronous `db.transaction()` callback, containing no `await` and no
 * possibility of one. That is the whole safety argument: better-sqlite3 is
 * synchronous on a single shared connection, so while this callback runs no
 * other code in this process runs at all. Nothing can observe the half-swapped
 * state, and nothing can accidentally join the transaction and be rolled back
 * with it.
 *
 * THE BOUNDARY OF THAT CLAIM. "Nothing else can lose its write" holds for every
 * write OUTSIDE the force set, which is every other writer in the app: the force
 * set is one user's provider-sourced mail inside the cache window, and no audit,
 * submission, or transaction writer touches it. A write INSIDE the force set
 * landing mid-rebuild is deleted by the swap on the success path — the one
 * writer that can do that is `syncTransactionEmails`, which shares the `emails`
 * table and is not behind `precacheInProgress`. Its rows are re-fetched by this
 * run anyway (same providers, same window), so the loss is a re-download rather
 * than data.
 *
 * If any step throws — a full disk, a constraint the rebuild violated — the
 * transaction rolls back and the user's store is the one they started with.
 */
export function swapEmailStagingIntoLive(
  db: DatabaseType,
  staging: EmailForceStaging,
  hooks: { persistAttachmentMeta: (meta: PendingAttachmentMeta) => void },
): EmailForceSwapCounts {
  const swap = db.transaction((): EmailForceSwapCounts => {
    const emailsDeleted = emailForceSwapSteps.deleteLiveForceSet(db, staging);
    const inserted = emailForceSwapSteps.insertFromStaging(db, staging);
    const resurrectionsRepaired = emailForceSwapSteps.applyResurrectionRepairs(db, staging);
    const attachmentMetaApplied = emailForceSwapSteps.applyAttachmentMeta(
      staging,
      hooks.persistAttachmentMeta,
    );
    return { emailsDeleted, ...inserted, resurrectionsRepaired, attachmentMetaApplied };
  });

  return swap();
}
