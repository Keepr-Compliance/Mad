/**
 * BACKLOG-2790 — stage-and-swap for Force Re-import.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY
 * ---------------------------------------------------------------------------
 * Force Re-import used to delete the user's entire message cache and then fetch
 * its replacement. BACKLOG-2775 made that survivable by wrapping the clear and
 * the re-import in ONE `BEGIN IMMEDIATE` transaction, so any interruption rolled
 * the deletion back. It worked — the founder verified it — but it bought
 * atomicity with a transaction held open for the entire run, minutes long, on a
 * connection every writer in this process shares. Anything that wrote during
 * that window silently JOINED the force transaction and died with its rollback,
 * which is why the quiesce machinery existed and why two residuals (event-driven
 * `insertAuditLog`, submissionSyncService's realtime subscription) stayed open.
 *
 * Stage-and-swap removes the window instead of narrowing it:
 *
 *   1. the rebuild is written into EPHEMERAL staging tables with ordinary short
 *      transactions — the live `messages` and `attachments` tables are not
 *      touched, read-only for the whole rebuild;
 *   2. at completion, ONE transaction deletes the force set from live and
 *      inserts the staging rows in its place;
 *   3. anything else — cancel, crash, disk-full, a thrown error — leaves live
 *      exactly as it was, by construction rather than by rollback.
 *
 * ---------------------------------------------------------------------------
 * WHY DELETE+INSERT AND NOT A TABLE SWAP
 * ---------------------------------------------------------------------------
 * `ALTER TABLE RENAME` is the tempting version and it is wrong here, three times
 * over:
 *
 *   - `messages` is SHARED. The force set is `user_id = ? AND external_id IS NOT
 *     NULL` — a strict subset. Rows with a NULL `external_id`, and any other
 *     user's rows, must survive a force re-import untouched. A rename replaces
 *     the whole table.
 *   - Five tables carry foreign keys to `messages(id)` (`attachments` and
 *     `communications` CASCADE; `transaction_stage_history`,
 *     `classification_feedback` and `extracted_transaction_data` SET NULL), plus
 *     thirteen indexes. Those are bound by NAME. A rename re-points or orphans
 *     them.
 *   - `attachments` is shared with email attachments, which this path must never
 *     see.
 *
 * Deleting the force set with the SAME statements the old clear used means every
 * cascade fires exactly as it does today — that is the behaviour-preservation
 * argument, and it is why the DELETEs below are transcribed from
 * `clearMacOSMessages` rather than rewritten.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import * as crypto from "crypto";
import {
  deriveStagingIndexDdl,
  deriveStagingTableDdl,
  checkedStagingTable,
  type StagingTableName,
  messageTableDdl as tableDdl,
} from "../db/stagingDdlSql";

/** Prefix every ephemeral table shares, so a crashed run's leftovers are findable. */
export const STAGING_TABLE_PREFIX = "staging_msgimport_";

/**
 * The provenance stamp the macOS importer writes into every row's `metadata`.
 *
 * `macOSMessagesImportService.storeMessages` builds
 * `JSON.stringify({ source: "macos_messages", originalId, service })` and passes
 * it as the `metadata` column of its one INSERT. `git log -S'source:
 * "macos_messages"'` over both the current path and the pre-split one returns a
 * single commit — `84c841252`, the commit that ADDED this service — so there is
 * no historical version of this importer that wrote a row without it.
 *
 * Nor is scoping a force delete by it a new convention. The ANDROID force
 * re-import already does exactly this: `localSyncService.clearAndroidData` calls
 * `syncDbService.deleteMessagesByMetadataSource(userId, "android_wifi_sync")`,
 * which is `DELETE FROM messages WHERE user_id = ? AND
 * json_extract(metadata, '$.source') = ?` (BACKLOG-1468). The macOS path was the
 * one that never got it.
 */
export const MACOS_IMPORT_METADATA_SOURCE = "macos_messages";

/**
 * The force set, as ONE definition: the rows a macOS Force Re-import replaces.
 *
 * Both the swap's DELETEs and the rebuild's "what will still be there" reads are
 * built from these constants. Two spellings of this predicate would be two
 * different answers to "what does a force re-import replace", and the drift
 * would be silent — the swap would delete rows the rebuild had assumed were
 * still there, or keep rows it had assumed were gone.
 *
 * `@userId` is the run's user throughout: the force set belongs to the user
 * whose import is running, so one bound parameter serves every use.
 *
 * ---------------------------------------------------------------------------
 * BACKLOG-2796 — WHY THIS IS SCOPED, AND WHY IT MUST STAY SCOPED
 * ---------------------------------------------------------------------------
 * This predicate used to be `user_id = @userId AND external_id IS NOT NULL` and
 * nothing more, which made a force re-import delete every row this user had from
 * ANY source and then rebuild only what chat.db could supply. A user with the
 * Android companion paired lost their Android SMS; an iPhone-sync user lost
 * their synced messages; `channel = 'email'` rows went with them. That predates
 * stage-and-swap — the old `clearMacOSMessages` deleted the same set — so the
 * set itself was the defect, not the machinery around it.
 *
 * The scope is the answer to one question: what can a chat.db rebuild put back?
 * Each clause is one half of that answer.
 *
 *   - `channel IN ('sms','imessage')` — chat.db holds texts. It cannot produce
 *     an email row, so a force re-import must not delete one.
 *   - the provenance clause — chat.db holds THIS Mac's texts. Channel alone is
 *     not enough, because the Android companion writes `channel: "sms"` too
 *     (`localSyncService.storeMessages`); the id shape is not enough either,
 *     because iPhone sync writes the SAME Apple GUID space into `external_id`
 *     (`iPhoneSyncStorageService`). What does separate them is the
 *     `metadata.$.source` each writer stamps on its own rows: `macos_messages`,
 *     `android_wifi_sync`, `iphone_sync`.
 *
 * ALLOW-LIST, NOT DENY-LIST, deliberately. Listing the sources to SPARE would
 * re-plant this bug for the fourth writer somebody adds. Naming the one source
 * this importer can rebuild means an unrecognised row survives by default, which
 * is the only defensible default for a predicate whose failure mode is deleting
 * the user's messages.
 *
 * `json_valid` is a guard, not decoration. `json_extract` THROWS `malformed
 * JSON` if it meets a single non-JSON `metadata` value among the rows it scans,
 * and a throw here aborts the entire swap. Measured on the real driver (sqlite
 * 3.53.2) over a table holding one `{"source":"macos_messages"}`, one
 * `not json at all` and one NULL: the bare form throws, the guarded form returns
 * exactly the one match. `json_valid(NULL)` is NULL, so a NULL-metadata row is
 * not in the force set — it survives, and `SURVIVING_MESSAGES` below is what
 * keeps the rebuild able to see it.
 */
export const FORCE_SET_MESSAGES =
  `user_id = @userId AND external_id IS NOT NULL ` +
  `AND channel IN ('sms', 'imessage') ` +
  `AND json_valid(metadata) ` +
  `AND json_extract(metadata, '$.source') = '${MACOS_IMPORT_METADATA_SOURCE}'`;
const FORCE_SET_MESSAGE_IDS = `SELECT id FROM messages WHERE ${FORCE_SET_MESSAGES}`;
const FORCE_SET_MESSAGE_EXTERNAL_IDS = `SELECT external_id FROM messages WHERE ${FORCE_SET_MESSAGES}`;
export const FORCE_SET_ATTACHMENTS_BY_MESSAGE_ID = `message_id IN (${FORCE_SET_MESSAGE_IDS})`;
export const FORCE_SET_ATTACHMENTS_BY_EXTERNAL_ID = `external_message_id IN (${FORCE_SET_MESSAGE_EXTERNAL_IDS})`;

/**
 * Rows of `messages` that a force re-import does NOT replace.
 *
 * NOT NULL-safe by hand, exactly like `SURVIVING_ATTACHMENTS` below — and it had
 * to become so when BACKLOG-2796 scoped the force set. It used to be a plain
 * `NOT (…)`, which was correct while the predicate could only be TRUE or FALSE:
 * `user_id` is NOT NULL and `external_id IS NOT NULL` is never itself NULL. The
 * scoped predicate CAN evaluate to NULL — `channel` is nullable past its CHECK
 * constraint, and `json_valid(NULL)` returns NULL rather than 0. For such a row
 * `NOT (force set)` is NULL, so the row would survive the DELETE (correct: a
 * DELETE removes a row only when its WHERE is TRUE) and then drop out of the
 * rebuild's survivor read (wrong) — which is precisely how a surviving row stops
 * being deduplicated against and has its GUID staged a second time. COALESCE
 * spells out what "survived" means: the force set was not TRUE.
 */
export const SURVIVING_MESSAGES = `COALESCE(${FORCE_SET_MESSAGES}, 0) = 0`;

/**
 * The `external_id`s of THIS USER's rows that a force re-import leaves in place.
 *
 * Scoped to `@userId` on purpose. `idx_messages_user_external_id` is UNIQUE on
 * `(user_id, external_id)`, so another user holding the same GUID is not a
 * conflict and must not make this run yield to it.
 */
const SURVIVING_MESSAGE_EXTERNAL_IDS = `SELECT external_id FROM messages WHERE user_id = @userId AND external_id IS NOT NULL AND ${SURVIVING_MESSAGES}`;

/**
 * Rows of `attachments` that a force re-import does NOT replace.
 *
 * NOT NULL-safe by hand, deliberately. `message_id IN (…)` evaluates to NULL —
 * not false — when `message_id` is NULL, which is exactly the shape of every
 * EMAIL attachment (they carry `email_id` instead). A plain
 * `NOT (a OR b)` would therefore evaluate to NULL for every email attachment and
 * silently drop the lot out of the rebuild's dedup sets, so a force re-import
 * would stop recognising files it had already copied for an email. A DELETE
 * removes a row only when its WHERE is TRUE, so "survived" is "neither predicate
 * was TRUE" — which is what COALESCE spells out.
 */
export const SURVIVING_ATTACHMENTS =
  `COALESCE(${FORCE_SET_ATTACHMENTS_BY_MESSAGE_ID}, 0) = 0 ` +
  `AND COALESCE(${FORCE_SET_ATTACHMENTS_BY_EXTERNAL_ID}, 0) = 0`;

/** A stale `message_id` on a LIVE attachment row, held back for the swap (TASK-1122). */
export interface PendingMessageIdRepair {
  readonly attachmentId: string;
  readonly messageId: string;
}

export interface ForceStaging {
  readonly userId: string;
  readonly messagesTable: string;
  readonly attachmentsTable: string;
  /**
   * TASK-1122 repairs aimed at rows that live in the REAL `attachments` table
   * rather than in staging. Applied as the swap's last step: today that UPDATE
   * runs inside the long force transaction and so becomes visible only at
   * COMMIT, and buffering reproduces exactly that visibility while keeping the
   * live table untouched for the length of the rebuild.
   */
  readonly messageIdRepairs: PendingMessageIdRepair[];
  /** Drop both tables. Idempotent; safe to call on any exit path. */
  drop(): void;
}

export interface ForceSwapCounts {
  messagesDeleted: number;
  attachmentsDeleted: number;
  messagesInserted: number;
  attachmentsInserted: number;
  messageIdsRepaired: number;
  /**
   * Staged rows the swap did NOT insert because a row this force re-import
   * leaves in place already holds their `external_id` (BACKLOG-2796). Normally
   * zero; see `insertFromStaging` for the one window that produces a non-zero
   * count. Counted and logged rather than dropped quietly — a skip nobody can
   * see is the thing this file spends most of its comments avoiding.
   */
  messagesYieldedToSurvivors: number;
  /** Staged attachments dropped with the messages that yielded above. */
  attachmentsYieldedToSurvivors: number;
}

/**
 * Drop every staging table left behind by a previous run.
 *
 * A process that dies between the rebuild and the swap leaves its staging tables
 * in the database — harmless (nothing reads them, and the live store is intact
 * precisely because the swap never ran) but not free. The next force run
 * reclaims them; no other code in the app knows these tables exist.
 *
 * THIS SWEEP IS NOT SCOPED, and the flag does not make it safe. An earlier
 * version of this comment claimed `forceReimportInProgress` guarantees at most
 * one force run per process. It does not. A second Force Re-import is not
 * refused — `importMessages` ABORTS the running import, waits 500 ms, clears
 * `isImporting`, and proceeds. The aborted run only notices at its next
 * cancellation check, so if that check is more than 500 ms away (a long text
 * extraction, a large batch) it is still writing to ITS staging tables when the
 * new run sweeps every `staging_msgimport_%` table in the database — including
 * the one still in use.
 *
 * The user's DATA is safe in every interleaving, which is why this is documented
 * rather than fixed here. The abandoned run writes only to staging and reads
 * live, so its next INSERT fails with "no such table" and reaches the outer
 * catch, which reports `rolledBack` — accurate, because it never swapped. Had
 * it reached the swap instead, `insertFromStaging` would throw INSIDE the
 * transaction and the DELETE would roll back with it. The cost is a confusing
 * error card on a run the user had already superseded, not a lost message.
 * Filed as BACKLOG-2797.
 *
 * BACKLOG-2768 (retention cleanup) is the durable reclaimer for a user who never
 * runs another force re-import.
 */
export function sweepStaleStaging(db: DatabaseType): string[] {
  // The escape character is escaped FIRST — or rather, in the same pass, which is
  // the point. Escaping only `_` leaves a backslash in the input free to pair
  // with the character after it and mean something else entirely, which is the
  // incomplete-sanitization shape CodeQL flags (js/incomplete-sanitization). The
  // input here is a module constant with neither a backslash nor a `%`, so
  // nothing is exploitable today; the reason to write it correctly anyway is that
  // "the input happens to be safe" is a property of a caller, not of this
  // function, and the next caller does not inherit the comment.
  const escapedPrefix = STAGING_TABLE_PREFIX.replace(/[\\%_]/g, "\\$&");
  const stale = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`
    )
    .all(`${escapedPrefix}%`) as Array<{ name: string }>;

  for (const { name } of stale) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  return stale.map((r) => r.name);
}

export const forceStagingLifecycle = {
  /**
   * Create this run's staging tables. Cheap: two `CREATE TABLE`s and a handful
   * of index definitions, no data copied — the rebuild fills them from chat.db.
   */
  create(db: DatabaseType, userId: string): ForceStaging {
    const token = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    // Checked at CONSTRUCTION — see the branded type in db/stagingDdlSql.
    const messagesTable = checkedStagingTable(
      `${STAGING_TABLE_PREFIX}${token}_messages`,
      "message-import",
    );
    const attachmentsTable = checkedStagingTable(
      `${STAGING_TABLE_PREFIX}${token}_attachments`,
      "message-import",
    );

    const pairs: Array<[live: string, staging: StagingTableName]> = [
      ["messages", messagesTable],
      ["attachments", attachmentsTable],
    ];

    for (const [live, staging] of pairs) {
      db.exec(deriveStagingTableDdl(tableDdl(db, live), live, staging));

      // Indexes are mirrored, not skipped. `INSERT OR IGNORE`'s dedup depends on
      // one of them — the partial unique index on (user_id, external_id) is what
      // makes a repeated GUID within a run an ignored no-op rather than a second
      // row — and carrying the rest keeps the rebuild's write cost the same shape
      // as writing to live, which is what it used to be.
      const indexes = db
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`
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
              `${STAGING_TABLE_PREFIX}${token}_${index.name}`,
              "message-import",
            )
          )
        );
      }
    }

    let dropped = false;
    return {
      userId,
      messagesTable,
      attachmentsTable,
      messageIdRepairs: [],
      drop(): void {
        if (dropped) return;
        dropped = true;
        db.exec(`DROP TABLE IF EXISTS "${attachmentsTable}"`);
        db.exec(`DROP TABLE IF EXISTS "${messagesTable}"`);
      },
    };
  },
};

/**
 * A read that must see what the live table WOULD look like at this point in a
 * force run: everything the swap will not delete, plus everything this run has
 * staged so far.
 *
 * This is the exact equivalence that makes the rebuild behaviour-preserving. The
 * old design cleared the live table first, so every dedup read inside the run
 * returned "survivors of the clear ∪ rows written so far". Reading only staging
 * would lose the survivors — most visibly the email attachments, whose copied
 * files the content-hash dedup must keep recognising.
 *
 * Columns are always listed explicitly. `SELECT *` here would drag `body_text`
 * for every row of a six-figure rebuild through a query that wants two columns.
 *
 * ## Duplicated with `db/emailForceSetSql.ts:emailForceReadView` — DELIBERATE
 *
 * BACKLOG-2989 commit A2 built a second union-view builder for the email force
 * re-cache instead of reusing this one, and did NOT move this one into `db/`.
 * That is not an oversight and the duplicate is not dead code — both are live.
 *
 * The two are not the same function yet. The email one builds its predicate
 * INSIDE `db/` from an `EmailForceSet` (data). This one RECEIVES its predicate
 * as TEXT — `SURVIVING_MESSAGES` / `SURVIVING_ATTACHMENTS`, authored here in
 * `services/`. Moving this signature into `db/` unchanged would freeze
 * predicate-as-text into the layer, which is precisely the design A2 exists to
 * remove; and changing it here would rewrite three call sites in
 * `macOSMessagesImportService.ts` (:1410, :1862, :1866) that belong to
 * BACKLOG-2990.
 *
 * **The collapse is BACKLOG-2990's**, once it builds its force set from data
 * too. `emailForceReadView` is the target shape. Until then, an edit to either
 * builder should be considered for both.
 */
export function forceReadView(
  liveTable: string,
  stagingTable: string,
  survivingRows: string,
  columns: string
): string {
  return (
    `(SELECT ${columns} FROM ${liveTable} WHERE ${survivingRows}` +
    ` UNION ALL SELECT ${columns} FROM "${stagingTable}")`
  );
}

/** How many rows a staging table holds, so a yielded row can be counted rather than inferred. */
function countRows(db: DatabaseType, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
}

/** The columns of a live table, in declaration order, quoted for reuse on both sides of the swap. */
function columnList(db: DatabaseType, table: string): string {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length === 0) {
    throw new Error(`Cannot swap: table "${table}" has no columns`);
  }
  return columns.map((c) => `"${c.name}"`).join(", ");
}

/**
 * The swap, as three named steps.
 *
 * They are separate and individually addressable ON PURPOSE: the property that
 * matters is that all three happen together or none of them does, and a control
 * can only demonstrate that by interrupting BETWEEN them. Injecting a failure at
 * the seam must leave the store untouched; running the same steps in separate
 * transactions must leave it emptied. That is the mutation that proves the
 * atomicity claim, and it needs the seam to exist.
 */
export const forceSwapSteps = {
  /**
   * Transcribed from the `clearMacOSMessages` this replaces — same predicates,
   * same order (attachments by message_id, then by external_message_id, then the
   * messages themselves), so every ON DELETE CASCADE and SET NULL fires exactly
   * as it does today. What is gone is the batching and the mid-delete cancel
   * check: both existed to keep a 35-second delete interruptible, and this
   * delete is neither long nor interruptible — it is one step of an atomic swap.
   */
  deleteLiveForceSet(
    db: DatabaseType,
    staging: ForceStaging
  ): { messagesDeleted: number; attachmentsDeleted: number } {
    const params = { userId: staging.userId };

    const byMessageId = db
      .prepare(`DELETE FROM attachments WHERE ${FORCE_SET_ATTACHMENTS_BY_MESSAGE_ID}`)
      .run(params);
    const byExternalId = db
      .prepare(`DELETE FROM attachments WHERE ${FORCE_SET_ATTACHMENTS_BY_EXTERNAL_ID}`)
      .run(params);
    const messages = db
      .prepare(`DELETE FROM messages WHERE ${FORCE_SET_MESSAGES}`)
      .run(params);

    return {
      messagesDeleted: messages.changes,
      attachmentsDeleted: byMessageId.changes + byExternalId.changes,
    };
  },

  /**
   * Messages before attachments, so `attachments.message_id`'s foreign key finds
   * its row.
   *
   * Plain `INSERT`, not `INSERT OR IGNORE`, and that is still the point: a
   * uniqueness conflict here means the force set and the rebuild disagree about
   * what a force re-import replaces, and throwing is the right answer to a
   * disagreement — it aborts the whole swap and leaves the user's store exactly
   * as it was, which `OR IGNORE` would turn into a silent partial import.
   *
   * WHAT CHANGED WITH BACKLOG-2796, because the old justification no longer
   * holds. It read: "the delete above has just removed every row in the space
   * these rows occupy". That was true of an unscoped force set, which deleted
   * every row of this user carrying an `external_id`. A SCOPED force set leaves
   * rows behind that still occupy part of that space — an iPhone-synced row, in
   * particular, whose `external_id` is drawn from the SAME Apple GUID space as
   * chat.db's.
   *
   * The rebuild already avoids staging those GUIDs: `storeMessages`' dedup read
   * unions the survivors in, so a GUID a surviving row holds is skipped, not
   * staged. The residue is a race, and it is a real one — neither
   * `localSyncService` nor `iPhoneSyncStorageService` is behind
   * `forceReimportInProgress` (they are reached from an inbound HTTP handler and
   * from the device sync orchestrator), so an iPhone row carrying a GUID this
   * run has already staged can land AFTER that dedup read and BEFORE this
   * insert. Android cannot collide: its `external_id` is a sha256 of
   * `sender|timestamp|body`, a disjoint id space.
   *
   * So the message insert yields that one row to the survivor rather than
   * throwing, which is exactly what the run would have done had the write landed
   * a moment earlier, and the attachment insert drops the staged attachments of
   * a yielded message so it cannot orphan them. Both are narrow on purpose:
   *
   *   - only staged rows whose GUID is held by a SURVIVING row of THIS user are
   *     yielded. Every other conflict still throws and still rolls the whole
   *     swap back.
   *   - only attachments belonging to a YIELDED staging message are dropped. An
   *     attachment pointing at an id that exists nowhere — the phantom-GUID
   *     hazard the `changes > 0` guard in `storeMessages` prevents — is NOT in
   *     that set, so it still reaches the live table and still fails the foreign
   *     key, which `forceStagingRealSchema-2790` pins.
   *
   * On the yielded attachments, stated at the strength it was actually
   * established — TRACED, NOT ASSERTED. The message they belong to is present,
   * which is what "yielded to a survivor" means, and the next ordinary delta
   * import should re-copy them: `storeAttachments` builds `alreadyStoredKeys`
   * from `external_message_id:filename` (which no longer matches), resolves the
   * GUID through `existingMessageIdMap` — the fallback at the `internalMessageId`
   * lookup, which reads LIVE messages — and links the copy to the survivor's row
   * id. That path was read end to end; it was not run. No force-path fixture
   * carries an attachment in its chat.db, so asserting it would have meant
   * building a source tree with real attachment files first, and a claim about
   * recovery is not worth a fixture invented to support it. What IS asserted is
   * the part that matters here: the yielded attachment is dropped rather than
   * left pointing at a row that was never inserted.
   */
  insertFromStaging(
    db: DatabaseType,
    staging: ForceStaging
  ): {
    messagesInserted: number;
    attachmentsInserted: number;
    messagesYieldedToSurvivors: number;
    attachmentsYieldedToSurvivors: number;
  } {
    const messageColumns = columnList(db, "messages");
    const attachmentColumns = columnList(db, "attachments");

    // Resolved ONCE, up front, into ids — not left as a subquery on `messages`
    // inside the two INSERTs. Both statements write to the very tables such a
    // subquery would read, and "does this SELECT see the rows this INSERT is
    // writing" is not a question worth depending on: with the messages already
    // inserted, every freshly-inserted row would answer the survivor test the
    // same way a real survivor does, and the attachment filter would drop the
    // whole rebuild's attachments. Ask before either write, and the answer
    // cannot drift. Normally the list is EMPTY and both statements are the ones
    // this function has always run.
    const yieldedMessageIds = (
      db
        .prepare(
          `SELECT id FROM "${staging.messagesTable}" ` +
            `WHERE external_id IN (${SURVIVING_MESSAGE_EXTERNAL_IDS})`
        )
        .all({ userId: staging.userId }) as Array<{ id: string }>
    ).map((row) => row.id);

    const stagedAttachments = countRows(db, staging.attachmentsTable);
    const placeholders = yieldedMessageIds.map(() => "?").join(", ");

    const messages = db
      .prepare(
        `INSERT INTO messages (${messageColumns}) ` +
          `SELECT ${messageColumns} FROM "${staging.messagesTable}"` +
          (yieldedMessageIds.length > 0 ? ` WHERE id NOT IN (${placeholders})` : "")
      )
      .run(...yieldedMessageIds);
    const attachments = db
      .prepare(
        `INSERT INTO attachments (${attachmentColumns}) ` +
          `SELECT ${attachmentColumns} FROM "${staging.attachmentsTable}"` +
          (yieldedMessageIds.length > 0
            ? ` WHERE message_id IS NULL OR message_id NOT IN (${placeholders})`
            : "")
      )
      .run(...yieldedMessageIds);

    return {
      messagesInserted: messages.changes,
      attachmentsInserted: attachments.changes,
      messagesYieldedToSurvivors: yieldedMessageIds.length,
      attachmentsYieldedToSurvivors: stagedAttachments - attachments.changes,
    };
  },

  /** TASK-1122 repairs against live rows the rebuild deliberately left alone. */
  applyMessageIdRepairs(db: DatabaseType, staging: ForceStaging): number {
    if (staging.messageIdRepairs.length === 0) return 0;
    const update = db.prepare(`UPDATE attachments SET message_id = ? WHERE id = ?`);
    let repaired = 0;
    for (const repair of staging.messageIdRepairs) {
      repaired += update.run(repair.messageId, repair.attachmentId).changes;
    }
    return repaired;
  },
};

/**
 * Put the rebuild in place.
 *
 * ONE synchronous `db.transaction()` callback, containing no `await` and no
 * possibility of one. That is the whole safety argument, and it is worth stating
 * plainly because it is what retired the quiesce machinery: better-sqlite3 is
 * synchronous on a single shared connection, so while this callback runs, no
 * other code in this process runs at all. Nothing can observe the half-swapped
 * state, and nothing can accidentally join the transaction and be rolled back
 * with it. The old force transaction stayed open across minutes of awaited
 * fetching, which is exactly why anything that wrote in that window was at risk
 * and why two writers had to be paused by hand.
 *
 * THE BOUNDARY OF THAT CLAIM, because it is not unconditional.
 *
 * "Nothing else can lose its write" is true of every write OUTSIDE the force set
 * — which is every writer the quiesce existed for: `markAuditLogsSynced`,
 * `updateTransactionSubmissionStatus`, event-driven `insertAuditLog`, and
 * submissionSyncService's realtime subscription. None of them touch
 * `messages WHERE user_id = <this user> AND external_id IS NOT NULL`, so the
 * DELETE below cannot reach them and the exposure is genuinely gone rather than
 * narrowed.
 *
 * A write INSIDE the force set, landing mid-rebuild, is deleted by the swap on
 * the success path — and BACKLOG-2796 is what made that sentence narrow enough
 * to be acceptable. It used to be alarming, because the force set was every row
 * this user had with an `external_id`, so the two OTHER services that write
 * messages wrote inside it:
 *
 *   - `localSyncService.storeMessages` — the Android WiFi companion, reached
 *     from an INBOUND HTTP handler (`POST /sync/messages` ->
 *     `handleSyncMessages`), so it fires at a moment nothing in this process
 *     controls;
 *   - `iPhoneSyncStorageService` — same shape, via the device sync orchestrator.
 *
 * Both insert through `databaseService.batchInsertMessages` ->
 * `syncDbService.batchInsertMessages`, and NEITHER is behind
 * `forceReimportInProgress`, which is read at exactly ONE site —
 * `macOSMessagesImportService.ts`'s
 * `if (this.forceReimportInProgress && !forceReimport)` — where it blocks a
 * second macOS import and knows nothing about an HTTP handler in another
 * service. That has not changed and is not fixable from here.
 *
 * What changed is that their rows are no longer IN the force set. Each writer
 * stamps its own `metadata.$.source`, the predicate above admits only
 * `macos_messages`, and so an Android batch or an iPhone batch landing at any
 * moment of a force re-import now survives it. That matters more than a
 * mid-run race, because it was never only about timing: before the scope, those
 * rows were deleted whether they arrived during the run or a month earlier.
 *
 * The one thing this does NOT fix, stated because the paragraph it replaces was
 * corrected once already for claiming a bound the code did not have: a mid-run
 * foreign write whose `external_id` collides with a GUID this run has staged.
 * Only iPhone sync can do it (Android's ids are sha256 digests, a disjoint
 * space). `insertFromStaging` yields that row to the survivor and counts it.
 *
 * The remaining occupants of the force set are this importer's own rows, and
 * `forceReimportInProgress` does block a second macOS import — so on the success
 * path a force re-import replaces exactly what it is a declaration about: the
 * rows chat.db is the authority for.
 *
 * Read BACKLOG-2796 before touching the predicate. WIDENING it is the defect
 * this scope exists to prevent.
 *
 * If any step throws — a full disk, a constraint the rebuild violated — the
 * transaction rolls back and the user's store is the one they started with.
 */
export function swapStagingIntoLive(
  db: DatabaseType,
  staging: ForceStaging
): ForceSwapCounts {
  const swap = db.transaction((): ForceSwapCounts => {
    const deleted = forceSwapSteps.deleteLiveForceSet(db, staging);
    const inserted = forceSwapSteps.insertFromStaging(db, staging);
    const messageIdsRepaired = forceSwapSteps.applyMessageIdRepairs(db, staging);
    return { ...deleted, ...inserted, messageIdsRepaired };
  });

  return swap();
}
