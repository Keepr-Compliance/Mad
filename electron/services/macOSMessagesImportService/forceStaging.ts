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

/** Prefix every ephemeral table shares, so a crashed run's leftovers are findable. */
export const STAGING_TABLE_PREFIX = "staging_msgimport_";

/**
 * The force set, as ONE definition.
 *
 * Both the swap's DELETEs and the rebuild's "what survived the clear" reads are
 * built from these constants. Two spellings of this predicate would be two
 * different answers to "what does a force re-import replace", and the drift
 * would be silent — the swap would delete rows the rebuild had assumed were
 * still there, or keep rows it had assumed were gone.
 *
 * `@userId` is the run's user throughout: the force set belongs to the user
 * whose import is running, so one bound parameter serves every use.
 */
export const FORCE_SET_MESSAGES = `user_id = @userId AND external_id IS NOT NULL`;
const FORCE_SET_MESSAGE_IDS = `SELECT id FROM messages WHERE ${FORCE_SET_MESSAGES}`;
const FORCE_SET_MESSAGE_EXTERNAL_IDS = `SELECT external_id FROM messages WHERE ${FORCE_SET_MESSAGES}`;
export const FORCE_SET_ATTACHMENTS_BY_MESSAGE_ID = `message_id IN (${FORCE_SET_MESSAGE_IDS})`;
export const FORCE_SET_ATTACHMENTS_BY_EXTERNAL_ID = `external_message_id IN (${FORCE_SET_MESSAGE_EXTERNAL_IDS})`;

/**
 * Rows of `messages` that a force re-import does NOT replace.
 *
 * Safe to negate directly: `user_id` is NOT NULL and `external_id IS NOT NULL`
 * is never itself NULL, so this is a plain boolean.
 */
export const SURVIVING_MESSAGES = `NOT (${FORCE_SET_MESSAGES})`;

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
}

/**
 * Rewrite one table's `CREATE TABLE` statement to define a staging clone.
 *
 * Derived from `sqlite_master` rather than hand-written, and NOT built with
 * `CREATE TABLE … AS SELECT * … WHERE 0`. The reason is column DEFAULTS: the
 * import's INSERTs name roughly sixteen of `messages`' forty columns and let the
 * table supply the rest (`has_attachments INTEGER DEFAULT 0`,
 * `is_false_positive INTEGER DEFAULT 0`, …). `CREATE TABLE … AS SELECT` copies
 * column names and types and drops every default, so staging would store NULL
 * where live stores 0 — and the swap would carry those NULLs into live. Deriving
 * the real DDL also means a future migration's new column arrives in staging on
 * its own, and that the simplified schema the real-driver test suites create is
 * mirrored just as faithfully as the production one.
 *
 * FOREIGN KEY clauses are stripped. Copied verbatim under `foreign_keys = ON`,
 * `attachments`' `REFERENCES messages(id)` would reject every staging insert:
 * the row it points at is in the staging messages table, not in live. The
 * constraint is not lost, only deferred to where it belongs — the swap inserts
 * into LIVE, where the real foreign keys apply to the real final state.
 */
export function deriveStagingTableDdl(
  liveDdl: string,
  liveTable: string,
  stagingTable: string
): string {
  const renamed = liveDdl.replace(
    new RegExp(
      `^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`\\[]?${liveTable}["'\`\\]]?`,
      "i"
    ),
    `CREATE TABLE ${stagingTable}`
  );
  if (renamed === liveDdl) {
    throw new Error(
      `Could not derive a staging table from the definition of "${liveTable}"`
    );
  }

  const referencesClause =
    `REFERENCES\\s+["'\`\\[]?\\w+["'\`\\]]?\\s*\\([^)]*\\)` +
    `(?:\\s+ON\\s+(?:DELETE|UPDATE)\\s+(?:NO\\s+ACTION|RESTRICT|SET\\s+NULL|SET\\s+DEFAULT|CASCADE))*` +
    `(?:\\s+(?:NOT\\s+)?DEFERRABLE(?:\\s+INITIALLY\\s+(?:DEFERRED|IMMEDIATE))?)?`;

  return (
    renamed
      // table-level: `, FOREIGN KEY (x) REFERENCES y(z) ON DELETE CASCADE`
      .replace(
        new RegExp(`,?\\s*FOREIGN\\s+KEY\\s*\\([^)]*\\)\\s*${referencesClause}`, "gi"),
        ""
      )
      // column-level: `x TEXT REFERENCES y(z)`
      .replace(new RegExp(`\\s+${referencesClause}`, "gi"), "")
      // tidy up whatever the removals left behind
      .replace(/,(\s*)\)/g, "$1)")
      .replace(/\((\s*),/g, "($1")
  );
}

/** Mirror one index definition onto the staging table, under a unique name. */
function deriveStagingIndexDdl(
  liveDdl: string,
  liveIndexName: string,
  liveTable: string,
  stagingTable: string,
  stagingIndexName: string
): string {
  return liveDdl
    .replace(
      new RegExp(
        `(CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)["'\`\\[]?${liveIndexName}["'\`\\]]?`,
        "i"
      ),
      `$1${stagingIndexName}`
    )
    .replace(
      new RegExp(`(\\sON\\s+)["'\`\\[]?${liveTable}["'\`\\]]?`, "i"),
      `$1${stagingTable}`
    );
}

function tableDdl(db: DatabaseType, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  if (!row?.sql) {
    throw new Error(`Cannot stage a force re-import: table "${table}" does not exist`);
  }
  return row.sql;
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
    const messagesTable = `${STAGING_TABLE_PREFIX}${token}_messages`;
    const attachmentsTable = `${STAGING_TABLE_PREFIX}${token}_attachments`;

    const pairs: Array<[live: string, staging: string]> = [
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
            `${STAGING_TABLE_PREFIX}${token}_${index.name}`
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
   * its row. Plain `INSERT`, not `INSERT OR IGNORE`: the delete above has just
   * removed every row in the space these rows occupy, so a uniqueness conflict
   * here would mean the force set and the rebuild disagree about what a force
   * re-import replaces. Throwing is the right answer to that — it aborts the
   * whole swap and leaves the user's store exactly as it was, which an
   * `OR IGNORE` would turn into a silent partial import.
   */
  insertFromStaging(
    db: DatabaseType,
    staging: ForceStaging
  ): { messagesInserted: number; attachmentsInserted: number } {
    const messageColumns = columnList(db, "messages");
    const attachmentColumns = columnList(db, "attachments");

    const messages = db
      .prepare(
        `INSERT INTO messages (${messageColumns}) SELECT ${messageColumns} FROM "${staging.messagesTable}"`
      )
      .run();
    const attachments = db
      .prepare(
        `INSERT INTO attachments (${attachmentColumns}) SELECT ${attachmentColumns} FROM "${staging.attachmentsTable}"`
      )
      .run();

    return {
      messagesInserted: messages.changes,
      attachmentsInserted: attachments.changes,
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
 * A write INSIDE the force set, landing mid-rebuild, is a different case and the
 * honest answer is that the swap deletes it. Compare the two designs on that
 * one row: the old transaction KEPT it if the run succeeded (it committed along
 * with everything else) and LOST it if the run was cancelled; this one LOSES it
 * if the run succeeds and KEEPS it if the run is cancelled. Neither is
 * uniformly better for that row, and both are dominated by the fact that a force
 * re-import is a declaration that chat.db is the authority for exactly those
 * rows — so replacing them is the requested behaviour, not a casualty.
 *
 * WHO ELSE WRITES INSIDE THE FORCE SET. Two other services do, and neither is
 * behind `forceReimportInProgress`:
 *
 *   - `localSyncService.storeMessages` (`localSyncService.ts`) — the Android
 *     WiFi companion. It builds rows with `channel: "sms"` and a non-null
 *     `externalId`, and it is reached from an INBOUND HTTP handler,
 *     `POST /sync/messages` -> `handleSyncMessages`, so it fires at a moment
 *     nothing in this process controls.
 *   - `iPhoneSyncStorageService` — same shape, `externalId: msg.guid`.
 *
 * Both insert through `databaseService.batchInsertMessages` ->
 * `syncDbService.batchInsertMessages`. `forceReimportInProgress` is read at
 * exactly ONE site — `macOSMessagesImportService.ts`'s
 * `if (this.forceReimportInProgress && !forceReimport)` — where it blocks a
 * second macOS import. It knows nothing about an HTTP handler in another
 * service.
 *
 * So a companion batch landing mid-rebuild IS deleted by the swap on the
 * success path. AND IT DOES NOT COME BACK: the companion advances a monotonic
 * cursor on the phone (`android-companion/services/backgroundSync.ts`, whose
 * native query is `minDate >=`), so it never re-reads a message it has already
 * sent. Do not write down that this self-heals — it was checked, and it does
 * not.
 *
 * None of that is introduced here. The old `clearMacOSMessages` deleted the
 * same set, because the set itself is the problem: it has no channel scope, so
 * a macOS Force Re-import reaches Android SMS, iPhone-synced messages and
 * `channel = 'email'` rows alike. **BACKLOG-2796** tracks scoping it. Read that
 * item before widening this predicate — and note that narrowing it is the fix,
 * not widening it.
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
