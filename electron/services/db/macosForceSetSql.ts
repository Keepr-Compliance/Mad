/**
 * The macOS Messages force-set predicate — BACKLOG-2990 chunk 5.
 *
 * Moved out of `services/macOSMessagesImportService/forceStaging.ts`, and this is
 * the ORIGIN of the SQL rather than a relocation of a signature. The old
 * `FORCE_SET_MESSAGES` / `SURVIVING_*` constants were exported TEXT: a predicate
 * authored in `services/` travelled into three DELETEs, a read view, a UNION
 * source and two INSERT filters. Those exports are gone. `MacOSForceSet` carries
 * DATA — whose rows, which channels, which metadata source — and every statement
 * is built here.
 *
 * This completes the collapse BACKLOG-2989 commit A2 began on the email side.
 * The two builders are now the same shape; `emailForceSetSql.ts` is its twin and
 * the duplication note on `forceReadView` is discharged.
 *
 * ## The rule, and why the exports below are allowed
 *
 * A `db/` export may not EXECUTE SQL text it received as a parameter.
 *
 * `macosForceReadView` takes a `columns` string and RETURNS text; it executes
 * nothing and its caller keeps its own verb, so every execution stays an
 * enumerated call site. `deleteLiveForceSet` and the swap helpers DO execute —
 * and take a `MacOSForceSet` and table names, never SQL. Neither has the
 * forbidden combination.
 *
 * ## Values cross the boundary; text does not
 *
 * `MACOS_IMPORT_METADATA_SOURCE` used to be INTERPOLATED into the predicate as a
 * quoted literal, and `@userId` was a named binding. Both are now BOUND, and the
 * channel list's placeholder width is derived from the array that is bound —
 * the same rule chunk 3a applied to the `IN (...)` lists, where a mutation
 * proved a hand-built width and its values can disagree.
 *
 * Parameters are POSITIONAL. `params` travels WITH the sql in one object so the
 * two cannot drift, and because better-sqlite3 refuses to mix `?` with `@name`
 * in one statement — which is why the old code had to spell some queries twice.
 */

import type { Database as DatabaseType } from "better-sqlite3";

import type { StagingTableName } from "./stagingDdlSql";

/** The metadata `$.source` value this importer owns. Data, not SQL. */
export const MACOS_IMPORT_METADATA_SOURCE = "macos_messages";

/** The channels a macOS Messages import writes. */
export const MACOS_IMPORT_CHANNELS = ["sms", "imessage"] as const;

/**
 * WHOSE rows a force re-import replaces, as data.
 *
 * ALLOW-LIST, NOT DENY-LIST, deliberately — kept from the original and still the
 * point. Listing the sources to SPARE would re-plant BACKLOG-2796's bug for the
 * fourth writer somebody adds. Naming the one source this importer can rebuild
 * means an unrecognised row SURVIVES by default, which is the only defensible
 * default for a predicate whose failure mode is deleting the user's messages.
 */
export interface MacOSForceSet {
  readonly userId: string;
  readonly source: string;
  readonly channels: readonly string[];
}

/** The set this importer always uses. Callers state the user; the rest is fixed. */
export function macOSForceSetFor(userId: string): MacOSForceSet {
  return {
    userId,
    source: MACOS_IMPORT_METADATA_SOURCE,
    channels: [...MACOS_IMPORT_CHANNELS],
  };
}

interface Fragment {
  readonly sql: string;
  readonly params: readonly string[];
}

/** Placeholder width derived from the array that is bound — never counted twice. */
const widthOf = (values: readonly unknown[]): string => values.map(() => "?").join(", ");

/**
 * Rows of `messages` a force re-import REPLACES.
 *
 * `json_valid` is a guard, not decoration. `json_extract` THROWS `malformed
 * JSON` if it meets a single non-JSON `metadata` value among the rows it scans,
 * and a throw here aborts the entire swap. Measured on the real driver
 * (sqlite 3.53.2) over a table holding one `{"source":"macos_messages"}`, one
 * `not json at all` and one NULL: the bare form throws, the guarded form returns
 * exactly the one match. `json_valid(NULL)` is NULL, so a NULL-metadata row is
 * not in the force set — it survives, and `survivingMessages` is what keeps the
 * rebuild able to see it.
 */
export function forceSetMessages(set: MacOSForceSet): Fragment {
  return {
    sql:
      `user_id = ? AND external_id IS NOT NULL ` +
      `AND channel IN (${widthOf(set.channels)}) ` +
      `AND json_valid(metadata) ` +
      `AND json_extract(metadata, '$.source') = ?`,
    params: [set.userId, ...set.channels, set.source],
  };
}

/**
 * Rows of `messages` a force re-import does NOT replace.
 *
 * NULL-safe by hand, and it had to become so when BACKLOG-2796 scoped the force
 * set. A plain `NOT (…)` was correct while the predicate could only be TRUE or
 * FALSE. The scoped predicate CAN evaluate to NULL — `channel` is nullable past
 * its CHECK constraint, and `json_valid(NULL)` returns NULL rather than 0. For
 * such a row `NOT (force set)` is NULL, so the row would survive the DELETE
 * (correct: a DELETE removes a row only when its WHERE is TRUE) and then drop
 * out of the rebuild's survivor read (wrong) — which is precisely how a
 * surviving row stops being deduplicated against and has its GUID staged a
 * second time. COALESCE spells out what "survived" means: the force set was not
 * TRUE.
 */
export function survivingMessages(set: MacOSForceSet): Fragment {
  const force = forceSetMessages(set);
  return { sql: `COALESCE(${force.sql}, 0) = 0`, params: force.params };
}

/** Attachments reachable from the force set by internal message id. */
export function forceSetAttachmentsByMessageId(set: MacOSForceSet): Fragment {
  const force = forceSetMessages(set);
  return {
    sql: `message_id IN (SELECT id FROM messages WHERE ${force.sql})`,
    params: force.params,
  };
}

/** Attachments reachable from the force set by external (Apple GUID) id. */
export function forceSetAttachmentsByExternalId(set: MacOSForceSet): Fragment {
  const force = forceSetMessages(set);
  return {
    sql: `external_message_id IN (SELECT external_id FROM messages WHERE ${force.sql})`,
    params: force.params,
  };
}

/**
 * Rows of `attachments` a force re-import does NOT replace.
 *
 * NULL-safe by hand, deliberately. `message_id IN (…)` evaluates to NULL — not
 * false — when `message_id` is NULL, which is exactly the shape of every EMAIL
 * attachment (they carry `email_id` instead). A plain `NOT (a OR b)` would
 * therefore be NULL for every email attachment and silently drop the lot out of
 * the rebuild's dedup sets, so a force re-import would stop recognising files it
 * had already copied for an email.
 */
export function survivingAttachments(set: MacOSForceSet): Fragment {
  const byMessage = forceSetAttachmentsByMessageId(set);
  const byExternal = forceSetAttachmentsByExternalId(set);
  return {
    sql:
      `COALESCE(${byMessage.sql}, 0) = 0 ` +
      `AND COALESCE(${byExternal.sql}, 0) = 0`,
    params: [...byMessage.params, ...byExternal.params],
  };
}

/**
 * "Survivors of the clear, UNION what this run has staged so far."
 *
 * The rebuild's dedup reads must see both halves. Reading only LIVE would match
 * a re-fetched row against the row this run is about to replace, classify it an
 * already-cached duplicate and never stage it — staging would finish empty and
 * the swap would delete the user's corpus and put nothing back. Reading only
 * STAGING loses the survivors, most visibly the attachments whose copied files
 * the content-hash dedup must keep recognising.
 *
 * Columns are always listed explicitly. `SELECT *` here would drag `body_text`
 * for every row of a six-figure rebuild through a query that wants two columns.
 *
 * This is the function `forceReadView` became. Its twin is
 * `emailForceSetSql.emailForceReadView`, and the two are now one shape.
 */
export function macosForceReadView(
  set: MacOSForceSet,
  liveTable: "messages" | "attachments",
  stagingTable: StagingTableName,
  columns: string,
): Fragment {
  const surviving = liveTable === "messages" ? survivingMessages(set) : survivingAttachments(set);
  return {
    sql:
      `(SELECT ${columns} FROM ${liveTable} WHERE ${surviving.sql}` +
      ` UNION ALL SELECT ${columns} FROM "${stagingTable}")`,
    params: surviving.params,
  };
}

/**
 * Delete the force set from the live tables.
 *
 * Transcribed from the `clearMacOSMessages` it replaced — same predicates, same
 * ORDER (attachments by message_id, then by external_message_id, then the
 * messages), so every `ON DELETE CASCADE` and `SET NULL` fires exactly as it did.
 *
 * Executes, and takes no SQL — only the set. It had to move here once the
 * predicate stopped travelling as text.
 */
export function deleteLiveForceSet(
  db: DatabaseType,
  set: MacOSForceSet,
): { messagesDeleted: number; attachmentsDeleted: number } {
  const byMessage = forceSetAttachmentsByMessageId(set);
  const byExternal = forceSetAttachmentsByExternalId(set);
  const force = forceSetMessages(set);

  const a1 = db.prepare(`DELETE FROM attachments WHERE ${byMessage.sql}`).run(...byMessage.params);
  const a2 = db
    .prepare(`DELETE FROM attachments WHERE ${byExternal.sql}`)
    .run(...byExternal.params);
  const m = db.prepare(`DELETE FROM messages WHERE ${force.sql}`).run(...force.params);

  return {
    messagesDeleted: m.changes,
    attachmentsDeleted: a1.changes + a2.changes,
  };
}

/**
 * Staged rows whose `external_id` a SURVIVING live row already holds.
 *
 * Asked BEFORE either insert, deliberately. `idx_messages_user_external_id` is
 * UNIQUE on `(user_id, external_id)`, and with the messages already inserted
 * every freshly-inserted row would answer the survivor test the same way a real
 * survivor does — the attachment filter would then drop the whole rebuild's
 * attachments. Asking once, before both writes, is what stops the answer
 * drifting between them. Normally this list is EMPTY.
 *
 * Scoped to the user on purpose: another user holding the same GUID is not a
 * conflict and must not make this run yield to it.
 */
export function selectYieldedMessageIds(
  db: DatabaseType,
  set: MacOSForceSet,
  stagingMessagesTable: StagingTableName,
): string[] {
  const surviving = survivingMessages(set);
  const rows = db
    .prepare(
      `SELECT id FROM "${stagingMessagesTable}" ` +
        `WHERE external_id IN (` +
        `SELECT external_id FROM messages ` +
        `WHERE user_id = ? AND external_id IS NOT NULL AND ${surviving.sql})`,
    )
    .all(set.userId, ...surviving.params) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * Insert the staged rows into a live table, skipping any the survivors already own.
 *
 * The `NOT IN` width comes from the same array that is bound. Chunk 3a's
 * MUTATION W showed a hand-built width and its values can disagree while a
 * one-element test stays green, so the two are computed from one input here.
 *
 * `message_id IS NULL OR …` on the attachment side is not optional: an email
 * attachment carries no `message_id`, and `NULL NOT IN (…)` is NULL, so without
 * the guard every email attachment would be filtered out of the rebuild.
 */
export function insertStagedRows(
  db: DatabaseType,
  liveTable: "messages" | "attachments",
  stagingTable: StagingTableName,
  columns: string,
  yieldedMessageIds: readonly string[],
): number {
  const skip =
    yieldedMessageIds.length === 0
      ? ""
      : liveTable === "messages"
        ? ` WHERE id NOT IN (${widthOf(yieldedMessageIds)})`
        : ` WHERE message_id IS NULL OR message_id NOT IN (${widthOf(yieldedMessageIds)})`;
  return db
    .prepare(
      `INSERT INTO ${liveTable} (${columns}) ` +
        `SELECT ${columns} FROM "${stagingTable}"` +
        skip,
    )
    .run(...yieldedMessageIds).changes;
}
