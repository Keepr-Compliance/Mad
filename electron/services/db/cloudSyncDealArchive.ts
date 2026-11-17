/**
 * Keepr Cloud deal archive — BACKLOG-4263 PR-4c (plan §14, F1–F9; founder answers Q3, Q7, Q8).
 *
 * A deal a Keepr Cloud user deletes on this computer can be restored here for 30 days. The delete stays the
 * hard delete it is today; in the same transaction, before the DELETE, a copy of the deal is written here:
 * - the deal row and the rows of the 15 tables the delete removes (the 12 with ON DELETE CASCADE to
 *   `transactions`, plus checklist items, links and members through `transaction_checklists`);
 * - for the 2 ON DELETE SET NULL tables (`classification_feedback`, `messages`), only the ids of the rows that
 *   named the deal (their rows survive the delete);
 * - the deal's Keepr Cloud todo records (the shadow of what the cloud confirmed and the ops still waiting), so a
 *   restore neither re-creates nor duplicates its todos online (W33);
 * - the online deal id, for "Delete for good" (Q8).
 *
 * THIS IS THE ONLY FILE THAT NAMES THE TABLE (apart from schema.sql, which declares it; F7). Every other file
 * calls the functions below. A test fails when any other source file names it, so exports, submissions, search,
 * counts and the AI tools cannot read it.
 *
 * Rules:
 * - Written only through `deleteTransactionSync(id, { archiveForRestore: true })`, which only the two delete
 *   handlers pass, and only when the deal's owner has Keepr Cloud on (read here, inside the delete's
 *   transaction). Every other delete (no flag) writes no row and erases any row for that deal id.
 * - Restore is one transaction, INSERT-only on the deal's own tables (an UPDATE of `transactions` would fire
 *   `update_transactions_timestamp` and change the restored row). Each child row goes in its own savepoint: a row
 *   whose email, text, attachment or contact is gone is skipped and counted (W35); a SET NULL-type reference whose
 *   row is gone is restored as NULL. The todo apply guard is held, so the capture triggers write no op.
 * - The rows are erased: after 30 days (purgeExpiredDealArchive, at every open and on the pass timer), by Delete
 *   for good, when the owner turns Keepr Cloud off, by cascade when the local user is deleted, after a backup
 *   restore for every deal the restored file holds, and for another Keepr Cloud project when it is forgotten.
 */
import type { SqlDb } from "./cloudSyncSqlDb";

export const DEAL_ARCHIVE_TABLE = "cloud_sync_deal_archive";

/** Mirrors schema.sql (the parity test compares them). */
export const DEAL_ARCHIVE_DDL = `CREATE TABLE IF NOT EXISTS cloud_sync_deal_archive (
  transaction_id TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL REFERENCES users_local(id) ON DELETE CASCADE,
  archived_at    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  purge_owed_at  TEXT
);`;

/** How long a deleted deal can be restored here (Q3). */
export const DEAL_RESTORE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The payload's own format (independent of the database schema version stored beside it). */
export const DEAL_ARCHIVE_FORMAT = 1;

/**
 * The 15 tables whose rows the deal delete removes, in the order a restore inserts them (parents first). `where`
 * selects the rows of one deal (one bound parameter: the deal id).
 */
export const DEAL_ARCHIVE_TABLES: ReadonlyArray<{ table: string; where: string }> = [
  { table: "audit_packages", where: "transaction_id = ?" },
  { table: "communications", where: "transaction_id = ?" },
  { table: "extracted_transaction_data", where: "transaction_id = ?" },
  { table: "ignored_communications", where: "transaction_id = ?" },
  { table: "pending_review_communications", where: "transaction_id = ?" },
  { table: "pending_review_match_reasons", where: "transaction_id = ?" },
  { table: "transaction_contacts", where: "transaction_id = ?" },
  { table: "transaction_participants", where: "transaction_id = ?" },
  { table: "transaction_stage_history", where: "transaction_id = ?" },
  { table: "transaction_hidden_texts", where: "transaction_id = ?" },
  { table: "transaction_checklists", where: "transaction_id = ?" },
  { table: "transaction_checklist_items", where: "checklist_id IN (SELECT c.id FROM transaction_checklists c WHERE c.transaction_id = ?)" },
  {
    table: "transaction_checklist_links",
    where:
      "item_id IN (SELECT i.id FROM transaction_checklist_items i JOIN transaction_checklists c ON c.id = i.checklist_id WHERE c.transaction_id = ?)",
  },
  {
    table: "transaction_checklist_link_members",
    where:
      "link_id IN (SELECT l.id FROM transaction_checklist_links l JOIN transaction_checklist_items i ON i.id = l.item_id JOIN transaction_checklists c ON c.id = i.checklist_id WHERE c.transaction_id = ?)",
  },
  { table: "transaction_opens", where: "transaction_id = ?" },
];

/** The 2 tables whose `transaction_id` the delete sets to NULL: only their ids are recorded. */
export const DEAL_ARCHIVE_SET_NULL_TABLES = ["classification_feedback", "messages"] as const;

/**
 * References that were ON DELETE SET NULL in the archived rows: when the referenced row is gone by restore time,
 * the column is restored as NULL (what the foreign key would have done had the row gone while the deal lived).
 */
const SET_NULL_REFS: Record<string, ReadonlyArray<{ column: string; table: string }>> = {
  extracted_transaction_data: [{ column: "source_message_id", table: "messages" }],
  transaction_stage_history: [{ column: "trigger_message_id", table: "messages" }],
};

type Row = Record<string, unknown>;

export interface DealArchivePayload {
  format: number;
  deal: Row;
  tables: Record<string, Row[]>;
  set_null: Record<string, string[]>;
  cloud: { project_ref: string; cloud_deal_id: string | null; todo_state: Row[]; todo_outbox: Row[] };
}

// ---------------------------------------------------------------- helpers

function hasTable(db: SqlDb, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnsOf(db: SqlDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** JSON cannot hold bytes; a byte value is stored as {"$bytes": base64} and decoded on restore. */
function encodeRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64") } : typeof v === "bigint" ? Number(v) : v;
  }
  return out;
}

function decodeValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $bytes?: unknown }).$bytes === "string") {
    return Buffer.from((v as { $bytes: string }).$bytes, "base64");
  }
  return v;
}

function dbSchemaVersion(db: SqlDb): number {
  try {
    const r = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number } | undefined;
    return typeof r?.version === "number" ? r.version : 0;
  } catch {
    return 0;
  }
}

/** The project in which the deal's owner has Keepr Cloud on, or null (never on, or turned off). */
function enabledProject(db: SqlDb, userId: string): string | null {
  if (!hasTable(db, "cloud_sync_settings")) return null;
  const r = db
    .prepare("SELECT project_ref FROM cloud_sync_settings WHERE user_id = ? AND enabled = 1 ORDER BY project_ref LIMIT 1")
    .get(userId) as { project_ref: string } | undefined;
  return r?.project_ref ?? null;
}

function readArchiveRow(db: SqlDb, transactionId: string): { owner_user_id: string; archived_at: string; payload_json: string; purge_owed_at: string | null } | null {
  return (
    (db
      .prepare(`SELECT owner_user_id, archived_at, payload_json, purge_owed_at FROM ${DEAL_ARCHIVE_TABLE} WHERE transaction_id = ?`)
      .get(transactionId) as { owner_user_id: string; archived_at: string; payload_json: string; purge_owed_at: string | null } | undefined) ?? null
  );
}

function parsePayload(json: string): DealArchivePayload | null {
  try {
    const p = JSON.parse(json) as DealArchivePayload;
    return p && typeof p === "object" && p.deal && typeof p.deal === "object" ? p : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- write (inside the delete's transaction)

/**
 * Called by deleteTransactionSync BEFORE its DELETE, inside the same transaction. With `archive` (only the two
 * delete handlers pass it) and the owner's Keepr Cloud on: writes (or replaces) the deal's archive row and returns
 * true. Otherwise writes nothing, erases any row for this deal id (a delete that is not a user delete, such as a
 * retention purge, never leaves a restorable copy; BACKLOG-3487 cross-lane note) and returns false.
 */
export function archiveDealBeforeDelete(db: SqlDb, transactionId: string, archive: boolean, now: Date): boolean {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return false;
  const deal = db.prepare("SELECT * FROM transactions WHERE id = ?").get(transactionId) as Row | undefined;
  const project = archive && deal ? enabledProject(db, String(deal.user_id)) : null;
  if (!deal || !project) {
    db.prepare(`DELETE FROM ${DEAL_ARCHIVE_TABLE} WHERE transaction_id = ?`).run(transactionId);
    return false;
  }
  const owner = String(deal.user_id);
  const tables: Record<string, Row[]> = {};
  for (const t of DEAL_ARCHIVE_TABLES) {
    tables[t.table] = hasTable(db, t.table)
      ? (db.prepare(`SELECT * FROM ${t.table} WHERE ${t.where} ORDER BY rowid`).all(transactionId) as Row[]).map(encodeRow)
      : [];
  }
  const setNull: Record<string, string[]> = {};
  for (const t of DEAL_ARCHIVE_SET_NULL_TABLES) {
    setNull[t] = hasTable(db, t)
      ? (db.prepare(`SELECT id FROM ${t} WHERE transaction_id = ? ORDER BY rowid`).all(transactionId) as Array<{ id: string }>).map((r) => r.id)
      : [];
  }
  const dealState = hasTable(db, "cloud_sync_state")
    ? (db
        .prepare("SELECT cloud_id FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id = ? AND entity = 'deal' AND local_id = ?")
        .get(project, owner, transactionId) as { cloud_id: string | null } | undefined)
    : undefined;
  const todoRows = (table: string): Row[] =>
    hasTable(db, table)
      ? (db.prepare(`SELECT * FROM ${table} WHERE project_ref = ? AND owner_user_id = ? AND transaction_id = ? ORDER BY rowid`).all(project, owner, transactionId) as Row[]).map(
          encodeRow,
        )
      : [];
  const payload: DealArchivePayload = {
    format: DEAL_ARCHIVE_FORMAT,
    deal: encodeRow(deal),
    tables,
    set_null: setNull,
    cloud: {
      project_ref: project,
      cloud_deal_id: dealState?.cloud_id ?? null,
      todo_state: todoRows("cloud_sync_todo_state"),
      todo_outbox: todoRows("cloud_sync_todo_outbox"),
    },
  };
  db.prepare(
    `INSERT INTO ${DEAL_ARCHIVE_TABLE} (transaction_id, owner_user_id, archived_at, payload_json, schema_version, purge_owed_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT (transaction_id) DO UPDATE SET owner_user_id = excluded.owner_user_id, archived_at = excluded.archived_at,
       payload_json = excluded.payload_json, schema_version = excluded.schema_version, purge_owed_at = NULL`,
  ).run(transactionId, owner, now.toISOString(), JSON.stringify(payload), dbSchemaVersion(db));
  return true;
}

// ---------------------------------------------------------------- the Removed list

export interface ArchivedDeal {
  transactionId: string;
  propertyAddress: string | null;
  archivedAt: string;
  restorableUntil: string;
  /** "Delete for good" was asked and is not finished yet: Restore is refused. */
  deleting: boolean;
}

/** One user's archived deals, newest first. Another local user's rows are never listed (F5). */
export function listArchivedDeals(db: SqlDb, userId: string): ArchivedDeal[] {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return [];
  const rows = db
    .prepare(
      `SELECT transaction_id, archived_at, purge_owed_at, json_extract(payload_json, '$.deal.property_address') AS address
         FROM ${DEAL_ARCHIVE_TABLE} WHERE owner_user_id = ? ORDER BY archived_at DESC, transaction_id`,
    )
    .all(userId) as Array<{ transaction_id: string; archived_at: string; purge_owed_at: string | null; address: string | null }>;
  return rows.map((r) => ({
    transactionId: r.transaction_id,
    propertyAddress: typeof r.address === "string" ? r.address : null,
    archivedAt: r.archived_at,
    restorableUntil: new Date(Date.parse(r.archived_at) + DEAL_RESTORE_DAYS * DAY_MS).toISOString(),
    deleting: r.purge_owed_at !== null,
  }));
}

/** The archive row of one deal of this user (the pull's restore check). */
export function hasArchivedDeal(db: SqlDb, userId: string, transactionId: string): boolean {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return false;
  return !!db.prepare(`SELECT 1 FROM ${DEAL_ARCHIVE_TABLE} WHERE transaction_id = ? AND owner_user_id = ?`).get(transactionId, userId);
}

// ---------------------------------------------------------------- restore

export type RestoreRefusal =
  /** No row (restored already, purged, or never archived). */
  | "not_found"
  /** The row belongs to another local user. */
  | "not_owner"
  /** "Delete for good" is under way. */
  | "purge_owed"
  /** A deal with this id is on this computer already; nothing changed, the archive row is kept. */
  | "deal_exists"
  /** The owner does not have Keepr Cloud on here. */
  | "cloud_off"
  /** The deal's own row could not be inserted; the whole restore rolled back, the archive row is kept. */
  | "restore_failed"
  /** A restore inside a pull: this computer's own removal of the deal is still waiting to be sent. */
  | "removal_pending";

export type RestoreResult =
  | {
      ok: true;
      /** Rows not restored, by table: a link whose email, text, attachment or contact is gone, and the like (W35). */
      skipped: Record<string, number>;
      skippedTotal: number;
      /** Another live deal of this user has the same address (restored anyway, no merge; F5). */
      otherDealAtAddress: boolean;
      archivedAt: string;
    }
  | { ok: false; code: RestoreRefusal };

export interface RestoreArgs {
  userId: string;
  transactionId: string;
  now: Date;
  /** Records the TRANSACTION_CREATE entry inside the restore's transaction (throws to cancel it). */
  audit: (entry: { userId: string; transactionId: string; archivedAt: string; via: "computer" | "online" }) => void;
  /** The caller (a pull page) already holds the todo apply guard: neither insert nor delete it. */
  guardHeld?: boolean;
  /** Restores triggered by a pull: refuse when this computer's own removal is still waiting to be sent. */
  refuseWhileRemovalPending?: boolean;
}

class RestoreAbort extends Error {
  constructor(readonly code: RestoreRefusal) {
    super(code);
  }
}

function insertRow(db: SqlDb, table: string, current: Set<string>, row: Row): void {
  const cols = Object.keys(row).filter((c) => current.has(c));
  db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...cols.map((c) => decodeValue(row[c])),
  );
}

/**
 * Restores one archived deal: one transaction (a savepoint inside a caller's). Preconditions (F5), then the guard,
 * the deal row, each table in FK order (column intersection: a column the archive lacks takes the current
 * default), the SET NULL re-links, the todo records, the audit entry, the archive row deleted, the deal marked for
 * the next pass. Any refusal changes nothing.
 */
export function restoreArchivedDeal(db: SqlDb, args: RestoreArgs): RestoreResult {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return { ok: false, code: "not_found" };
  try {
    return db.transaction((): RestoreResult => {
      const row = readArchiveRow(db, args.transactionId);
      if (!row) throw new RestoreAbort("not_found");
      if (row.owner_user_id !== args.userId) throw new RestoreAbort("not_owner");
      if (row.purge_owed_at !== null) throw new RestoreAbort("purge_owed");
      if (db.prepare("SELECT 1 FROM transactions WHERE id = ?").get(args.transactionId)) throw new RestoreAbort("deal_exists");
      const payload = parsePayload(row.payload_json);
      if (!payload) throw new RestoreAbort("restore_failed");
      const project = payload.cloud?.project_ref;
      if (!project || enabledProject(db, args.userId) !== project) throw new RestoreAbort("cloud_off");
      if (args.refuseWhileRemovalPending && db.prepare("SELECT 1 FROM cloud_sync_dirty WHERE transaction_id = ?").get(args.transactionId)) {
        throw new RestoreAbort("removal_pending");
      }

      let guardInserted = false;
      if (!args.guardHeld) {
        const r = db.prepare("INSERT OR IGNORE INTO cloud_sync_applying (id, started_at) VALUES (1, ?)").run(args.now.toISOString()) as
          | { changes?: number }
          | undefined;
        guardInserted = Number(r?.changes ?? 0) > 0;
      }

      // The deal row: must succeed (a failure throws and rolls the whole restore back).
      insertRow(db, "transactions", new Set(columnsOf(db, "transactions")), payload.deal);

      const skipped: Record<string, number> = {};
      const skip = (table: string) => {
        skipped[table] = (skipped[table] ?? 0) + 1;
      };
      const restoredLinks = new Map<string, { members: number; restored: number }>();
      for (const t of DEAL_ARCHIVE_TABLES) {
        const rows = payload.tables?.[t.table] ?? [];
        if (rows.length === 0) continue;
        const current = new Set(columnsOf(db, t.table));
        if (current.size === 0) {
          for (let i = 0; i < rows.length; i++) skip(t.table);
          continue;
        }
        for (const archived of rows) {
          const r: Row = { ...archived };
          for (const ref of SET_NULL_REFS[t.table] ?? []) {
            const v = r[ref.column];
            if (v !== null && v !== undefined && !db.prepare(`SELECT 1 FROM ${ref.table} WHERE id = ?`).get(v)) r[ref.column] = null;
          }
          // A review-queue row whose email is now linked to another deal stays with that deal.
          if (
            t.table === "pending_review_communications" &&
            r.email_id &&
            db.prepare("SELECT 1 FROM communications WHERE email_id = ? AND transaction_id IS NOT NULL AND transaction_id <> ?").get(r.email_id, args.transactionId)
          ) {
            skip(t.table);
            continue;
          }
          if (t.table === "transaction_checklist_link_members") {
            const l = restoredLinks.get(String(r.link_id));
            if (l) l.members++;
            if (!l) {
              skip(t.table);
              continue;
            }
          }
          try {
            db.transaction(() => insertRow(db, t.table, current, r))();
            if (t.table === "transaction_checklist_links") restoredLinks.set(String(r.id), { members: 0, restored: 0 });
            if (t.table === "transaction_checklist_link_members") (restoredLinks.get(String(r.link_id)) as { restored: number }).restored++;
          } catch {
            skip(t.table);
          }
        }
      }
      // A checklist link whose members were all skipped is not restored (an empty link means nothing).
      for (const [linkId, l] of restoredLinks) {
        if (l.members > 0 && l.restored === 0) {
          db.prepare("DELETE FROM transaction_checklist_links WHERE id = ?").run(linkId);
          skip("transaction_checklist_links");
        }
      }

      // SET NULL tables (F1): set back only where the row still exists and still names no deal.
      for (const id of payload.set_null?.classification_feedback ?? []) {
        db.prepare("UPDATE classification_feedback SET transaction_id = ? WHERE id = ? AND transaction_id IS NULL").run(args.transactionId, id);
      }
      for (const id of payload.set_null?.messages ?? []) {
        db.prepare("UPDATE messages SET transaction_id = ? WHERE id = ? AND transaction_id IS NULL").run(args.transactionId, id);
      }

      // The deal's todo records (W33): kept where newer ones exist (a restore before the removal was sent).
      restoreCloudRows(db, "cloud_sync_todo_state", payload.cloud.todo_state ?? []);
      restoreCloudRows(db, "cloud_sync_todo_outbox", payload.cloud.todo_outbox ?? []);

      args.audit({ userId: args.userId, transactionId: args.transactionId, archivedAt: row.archived_at, via: args.guardHeld ? "online" : "computer" });

      db.prepare(`DELETE FROM ${DEAL_ARCHIVE_TABLE} WHERE transaction_id = ?`).run(args.transactionId);
      if (guardInserted) db.prepare("DELETE FROM cloud_sync_applying WHERE id = 1").run();
      // The next pass uploads the deal again, which un-removes it online under the same id (F4).
      if (hasTable(db, "cloud_sync_dirty")) {
        db.prepare(
          `INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) VALUES (?, 1, CURRENT_TIMESTAMP)
           ON CONFLICT (transaction_id) DO UPDATE SET generation = generation + 1, marked_at = excluded.marked_at`,
        ).run(args.transactionId);
      }

      const address = payload.deal.property_address;
      const otherDealAtAddress =
        typeof address === "string" && address.trim() !== ""
          ? !!db
              .prepare("SELECT 1 FROM transactions WHERE user_id = ? AND id <> ? AND lower(trim(property_address)) = lower(trim(?)) LIMIT 1")
              .get(args.userId, args.transactionId, address)
          : false;
      const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
      return { ok: true, skipped, skippedTotal, otherDealAtAddress, archivedAt: row.archived_at };
    })();
  } catch (error) {
    if (error instanceof RestoreAbort) return { ok: false, code: error.code };
    return { ok: false, code: "restore_failed" };
  }
}

function restoreCloudRows(db: SqlDb, table: string, rows: Row[]): void {
  if (rows.length === 0 || !hasTable(db, table)) return;
  const current = new Set(columnsOf(db, table));
  for (const r of rows) {
    const cols = Object.keys(r).filter((c) => current.has(c));
    db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      ...cols.map((c) => decodeValue(r[c])),
    );
  }
}

// ---------------------------------------------------------------- Delete for good (Q8)

export interface OwedPurge {
  transactionId: string;
  projectRef: string | null;
  cloudDealId: string | null;
}

/** Step 1 of Delete for good, one transaction: mark the row owed (Restore is refused from now on). */
export function markDealPurgeOwed(db: SqlDb, userId: string, transactionId: string, now: Date): "ok" | "not_found" | "not_owner" {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return "not_found";
  return db.transaction(() => {
    const row = readArchiveRow(db, transactionId);
    if (!row) return "not_found" as const;
    if (row.owner_user_id !== userId) return "not_owner" as const;
    if (row.purge_owed_at === null) {
      db.prepare(`UPDATE ${DEAL_ARCHIVE_TABLE} SET purge_owed_at = ? WHERE transaction_id = ?`).run(now.toISOString(), transactionId);
    }
    return "ok" as const;
  })();
}

/** This user's rows with Delete for good still to finish, oldest first. */
export function listOwedDealPurges(db: SqlDb, userId: string): OwedPurge[] {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return [];
  const rows = db
    .prepare(
      `SELECT transaction_id, json_extract(payload_json, '$.cloud.project_ref') AS project_ref,
              json_extract(payload_json, '$.cloud.cloud_deal_id') AS cloud_deal_id
         FROM ${DEAL_ARCHIVE_TABLE} WHERE owner_user_id = ? AND purge_owed_at IS NOT NULL ORDER BY purge_owed_at, transaction_id`,
    )
    .all(userId) as Array<{ transaction_id: string; project_ref: string | null; cloud_deal_id: string | null }>;
  return rows.map((r) => ({ transactionId: r.transaction_id, projectRef: r.project_ref ?? null, cloudDealId: r.cloud_deal_id ?? null }));
}

/** Step 3 of Delete for good (the server answered purged or not_found): the row goes. Idempotent. */
export function completeDealPurge(db: SqlDb, userId: string, transactionId: string): void {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return;
  db.prepare(`DELETE FROM ${DEAL_ARCHIVE_TABLE} WHERE transaction_id = ? AND owner_user_id = ? AND purge_owed_at IS NOT NULL`).run(transactionId, userId);
}

/** The server answered not_removed (restored elsewhere): the owed mark is cleared. */
export function clearDealPurgeOwed(db: SqlDb, userId: string, transactionId: string): void {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return;
  db.prepare(`UPDATE ${DEAL_ARCHIVE_TABLE} SET purge_owed_at = NULL WHERE transaction_id = ? AND owner_user_id = ?`).run(transactionId, userId);
}

// ---------------------------------------------------------------- erasure points (F6)

/**
 * The 30-day purge: every row archived DEAL_RESTORE_DAYS or more before `now` goes, for every owner. Run at every
 * open and on the pass timer (never behind a pass's early returns). Returns the rows deleted.
 */
export function purgeExpiredDealArchive(db: SqlDb, now: Date): number {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return 0;
  const cutoff = new Date(now.getTime() - DEAL_RESTORE_DAYS * DAY_MS).toISOString();
  const r = db.prepare(`DELETE FROM ${DEAL_ARCHIVE_TABLE} WHERE archived_at <= ?`).run(cutoff) as { changes?: number } | undefined;
  return Number(r?.changes ?? 0);
}

/** Turning Keepr Cloud off: that user's rows go, in the caller's transaction. */
export function deleteDealArchiveForUser(db: SqlDb, userId: string): void {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return;
  db.prepare(`DELETE FROM ${DEAL_ARCHIVE_TABLE} WHERE owner_user_id = ?`).run(userId);
}

/** Forgetting another Keepr Cloud project: rows archived under any other project go. */
export function deleteDealArchiveOtherProjects(db: SqlDb, projectRef: string): void {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return;
  db.prepare(`DELETE FROM ${DEAL_ARCHIVE_TABLE} WHERE json_extract(payload_json, '$.cloud.project_ref') IS NOT ?`).run(projectRef);
}

/** After a backup restore: a row whose deal the restored file holds goes. */
export function deleteDealArchiveForExistingDeals(db: SqlDb): void {
  if (!hasTable(db, DEAL_ARCHIVE_TABLE)) return;
  db.exec(`DELETE FROM ${DEAL_ARCHIVE_TABLE} WHERE transaction_id IN (SELECT id FROM transactions)`);
}
