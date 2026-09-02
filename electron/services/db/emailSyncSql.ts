/**
 * SQL for the email sync write and dedup paths — BACKLOG-2989 chunk 4.
 *
 * Moved out of `electron/services/emailSyncService.ts`: three sites the gate
 * could see, and six it could not. The six went through `dbGet`/`dbAll`/`dbRun`,
 * whose `.prepare()` lives inside `db/core/dbConnection` — so the statement
 * classified `in-layer` COMPLIANT once, at the helper, and every caller passing
 * raw SQL contributed ZERO call sites. BACKLOG-3044 has the full census; this
 * file's six are the only ones inside BACKLOG-2989's move set.
 *
 * ## The invariant this module exists to hold
 *
 * **Every declaration between a staging name's construction and its use in SQL
 * preserves the brand.**
 *
 * That is stated as an invariant rather than as "we added a brand" because the
 * brand has now been lost twice, each time one level below where the previous
 * fix looked. A1 branded the `derive*` PARAMETERS; A2 then declared
 * `EmailForceStaging.emailsTable: string` and threw it away at the interface.
 * The caller here did it a third way:
 *
 *     const writeEmailsTable = force ? `"${force.emailsTable}"` : "emails";
 *
 * `force.emailsTable` is a `StagingTableName`, and wrapping it in quotes
 * produces a plain `string` — the brand destroyed by a template literal, with
 * no annotation to notice. So the quoting moves in here, and what crosses the
 * boundary is a DISCRIMINATED TARGET carrying the branded name, never a
 * pre-quoted identifier.
 *
 * ## Why a discriminated union rather than two nullable fields
 *
 * `{ mode: "live" }` or `{ mode: "force", … }` makes the invalid states
 * unrepresentable: there is no way to supply a staging table without being in
 * force mode, or to be in force mode with a missing table. A `force: X | null`
 * plus `staging: Y | null` pair would admit two combinations that mean nothing.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";

import { dbAll, dbGet, dbRun } from "./core/dbConnection";
import { emailForceReadView, type EmailForceSet } from "./emailForceSetSql";
import type { StagingTableName } from "./stagingDdlSql";

/** Where a sync run WRITES: live tables, or this run's staging pair. */
export type EmailWriteTarget =
  | { readonly mode: "live" }
  | {
      readonly mode: "force";
      readonly emailsTable: StagingTableName;
      readonly participantsTable: StagingTableName;
    };

/**
 * Where a sync run READS its dedup lookups from: live `emails`, or the
 * force-mode union of live survivors and what this run has staged so far.
 */
export type EmailReadSource =
  | { readonly mode: "live" }
  | {
      readonly mode: "force";
      readonly set: EmailForceSet;
      readonly emailsTable: StagingTableName;
    };

/** Quoting happens HERE, on a name the type system has already vouched for. */
const emailsWriteTable = (t: EmailWriteTarget): string =>
  t.mode === "force" ? `"${t.emailsTable}"` : "emails";

const participantsWriteTable = (t: EmailWriteTarget): string =>
  t.mode === "force" ? `"${t.participantsTable}"` : "email_participants";

/**
 * The read source, as `{ sql, params }`. In live mode it is the bare table and
 * no parameters; in force mode `emailForceReadView` builds the survivors-UNION-
 * staged view and returns the predicate's bindings, which must precede the
 * caller's own.
 */
function readSource(
  source: EmailReadSource,
  columns: string,
): { sql: string; params: readonly string[] } {
  return source.mode === "force"
    ? emailForceReadView(source.set, source.emailsTable, columns)
    : { sql: "emails", params: [] };
}

/**
 * Rows are inserted with an explicit column list and `CURRENT_TIMESTAMP` for
 * `created_at`.
 *
 * `derived_version` is APPENDED after every other bound parameter on purpose:
 * `emailSyncService.retainedHeaders.test.ts` transcribes positional indices
 * into this list, so inserting mid-list would silently re-point its assertions
 * at the wrong columns.
 */
export function prepareEmailInsert(
  db: DatabaseType,
  target: EmailWriteTarget,
): Statement<unknown[]> {
  return db.prepare(`
        INSERT INTO ${emailsWriteTable(target)} (
          id, user_id, external_id, source, account_id, direction,
          subject, body_plain, body_html,
          sender, recipients, cc, bcc,
          thread_id, in_reply_to, references_header,
          sent_at, received_at,
          has_attachments, attachment_count,
          message_id_header, content_hash, labels,
          bulk_mail_headers,
          ingest_source, validated_at,
          -- BACKLOG-2857: stamped at write time so a later derivation fix can
          -- tell this row apart from one produced by superseded logic.
          -- APPENDED after every other bound parameter on purpose:
          -- emailSyncService.retainedHeaders.test.ts transcribes positional
          -- indices into this list, so inserting mid-list would silently
          -- re-point its assertions at the wrong columns.
          derived_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
}

/** BACKLOG-1722: the junction participant INSERT, prepared once and reused. */
export function prepareParticipantInsert(
  db: DatabaseType,
  target: EmailWriteTarget,
): Statement<unknown[]> {
  return db.prepare(`
        INSERT INTO ${participantsWriteTable(target)}
          (email_id, role, position, participant_hash, email_address, display_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
}

/**
 * BACKLOG-1769: point an already-stored row at the new provider id, keeping the
 * Message-ID it already had. `COALESCE` so a row that already knows its header
 * does not lose it to a NULL.
 *
 * The same statement is used by the force re-cache swap — its second baseline
 * entry, under `emailForceStaging.ts`, closes when chunk 5 imports this const.
 */
export const UPDATE_EMAIL_IDENTITY_SQL = `UPDATE emails SET external_id = ?, message_id_header = COALESCE(message_id_header, ?) WHERE id = ?`;

/** The newest mail this user has stored — the incremental sync's high-water mark. */
export const LATEST_SENT_AT_SQL =
  "SELECT MAX(sent_at) as latest FROM emails WHERE user_id = ?";

/** Reset the provider cursor so the next run starts from the beginning. */
export const CLEAR_SYNC_CURSOR_SQL = `UPDATE email_sync_state SET cursor = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`;

/**
 * Which external ids among `externalIds` are already stored.
 *
 * Takes the VALUES and derives the `IN` width from them, so a same-length
 * different-values divergence is unrepresentable rather than merely unlikely —
 * the lesson from chunk 4a's dedup lookups.
 *
 * The caller chunks at 500 to stay under SQLite's variable limit; an empty
 * chunk is answered without a query, because `IN ()` is valid SQL that matches
 * nothing and would look like a clean result.
 */
export function selectExistingExternalIds(
  source: EmailReadSource,
  userId: string,
  externalIds: readonly string[],
): Array<{ external_id: string }> {
  if (externalIds.length === 0) return [];
  const src = readSource(source, "external_id, user_id");
  const placeholders = externalIds.map(() => "?").join(",");
  return dbAll<{ external_id: string }>(
    `SELECT external_id FROM ${src.sql} WHERE user_id = ? AND external_id IN (${placeholders})`,
    [...src.params, userId, ...externalIds],
  );
}

/**
 * BACKLOG-1769: already-stored rows by RFC Message-ID, so a re-delivered
 * message — new provider id, same Message-ID — is caught as a RESURRECTION
 * rather than inserted as a ghost row.
 */
export function selectExistingByMessageIdHeader(
  source: EmailReadSource,
  userId: string,
  headers: readonly string[],
): Array<{ id: string; external_id: string | null; message_id_header: string }> {
  if (headers.length === 0) return [];
  const src = readSource(source, "id, external_id, message_id_header, user_id");
  const placeholders = headers.map(() => "?").join(",");
  return dbAll(
    `SELECT id, external_id, message_id_header FROM ${src.sql} WHERE user_id = ? AND message_id_header IN (${placeholders})`,
    [...src.params, userId, ...headers],
  );
}

/**
 * BACKLOG-1769 legacy fallback: rows stored BEFORE Message-ID was captured, so
 * a re-delivery can still be matched by content rather than inserted twice.
 *
 * `message_id_header IS NULL` is the definition of "legacy" here — a row that
 * HAS a header is matched by the header lookup above and must not be matched
 * again by a weaker key. The three `IS NOT NULL` guards are what make the
 * content key computable at all; without them the key is built from missing
 * parts and collides.
 *
 * Matched on `LOWER(TRIM(subject))` because the caller's key is built from a
 * normalised subject; comparing raw would miss the rows this exists to find.
 */
export function selectLegacyCandidatesBySubject(
  source: EmailReadSource,
  userId: string,
  normalisedSubjects: readonly string[],
): Array<{
  id: string;
  external_id: string | null;
  subject: string;
  sender: string;
  sent_at: string;
}> {
  if (normalisedSubjects.length === 0) return [];
  const src = readSource(
    source,
    "id, external_id, subject, sender, sent_at, user_id, message_id_header",
  );
  const placeholders = normalisedSubjects.map(() => "?").join(",");
  return dbAll(
    `SELECT id, external_id, subject, sender, sent_at
           FROM ${src.sql}
           WHERE user_id = ?
             AND message_id_header IS NULL
             AND sent_at IS NOT NULL
             AND sender IS NOT NULL
             AND subject IS NOT NULL
             AND LOWER(TRIM(subject)) IN (${placeholders})`,
    [...src.params, userId, ...normalisedSubjects],
  );
}

/**
 * The earliest mail involving any of a contact's addresses, and how many rows
 * that covers — the "we have history back to X" figure.
 *
 * Reads the `email_participants` junction rather than scanning `emails`, so a
 * BCC-only appearance still counts. Width derives from the addresses bound.
 */
export function selectEarliestByParticipants(
  userId: string,
  addresses: readonly string[],
): { earliest: string | null; total: number } | undefined {
  if (addresses.length === 0) return undefined;
  const placeholders = addresses.map(() => "?").join(", ");
  return dbGet<{ earliest: string | null; total: number }>(
    `
  SELECT MIN(e.sent_at) as earliest, COUNT(DISTINCT e.id) as total
  FROM email_participants ep
  JOIN emails e ON e.id = ep.email_id
  WHERE e.user_id = ?
    AND ep.email_address IN (${placeholders})
`,
    [userId, ...addresses],
  );
}

/**
 * The newest `sent_at` this user has stored — the incremental sync's
 * high-water mark. Executed here so the caller holds no SQL at all: passing
 * even a db/-owned constant through `dbGet` leaves the statement invisible to
 * the boundary gate, which is BACKLOG-3044's subject.
 */
export function selectLatestSentAt(userId: string): { latest: string | null } | undefined {
  return dbGet<{ latest: string | null }>(LATEST_SENT_AT_SQL, [userId]);
}

/** Reset the provider cursor so the next run starts from the beginning. */
export function clearSyncCursor(userId: string): void {
  dbRun(CLEAR_SYNC_CURSOR_SQL, [userId]);
}
