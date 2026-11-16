/**
 * Keepr Cloud local SQL — BACKLOG-4243 PR-2.
 *
 * The five `cloud_sync_*` tables (declared in schema.sql, mirrored here for
 * the parity test and for suites that build a database from parts), the
 * dirty-mark triggers, and the statements the engine runs. Plan §6, §7.
 *
 * Trigger rules (plan §7.1, §7.2):
 * - every body is an UPSERT into cloud_sync_dirty that cannot violate a
 *   constraint, guarded by `WHERE <id> IS NOT NULL` (a child row whose parent
 *   is gone during a cascade resolves to NULL and marks nothing);
 * - every trigger has `WHEN EXISTS (SELECT 1 FROM cloud_sync_settings WHERE
 *   enabled = 1)`, so nothing is marked on a database where Keepr Cloud was
 *   never turned on;
 * - they are dropped before schema.sql and the versioned migrations run and
 *   created after them (cloudSyncTriggers.ts), never declared in schema.sql.
 */
import {
  CHECKLIST_SOURCE_COLUMNS,
  DEAL_SOURCE_COLUMNS,
  ITEM_SOURCE_COLUMNS,
  PARTY_CONTACT_COLUMNS,
  PARTY_EMAIL_COLUMNS,
  PARTY_PHONE_COLUMNS,
  PARTY_ROW_COLUMNS,
  PARTY_SOURCE_LINK_COLUMNS,
} from "../cloudSync/projection";

export const CLOUD_SYNC_TABLES_DDL = `CREATE TABLE IF NOT EXISTS cloud_sync_install (
  project_ref  TEXT PRIMARY KEY,
  install_id   TEXT NOT NULL,
  machine_hash TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cloud_sync_settings (
  project_ref        TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  local_confirmed_at TEXT,
  notice_version     INTEGER,
  accepted_at        TEXT,
  last_state_json    TEXT,
  last_state_at      TEXT,
  turn_off_owed_at   TEXT,
  PRIMARY KEY (project_ref, user_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_state (
  project_ref     TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  entity          TEXT NOT NULL,
  local_id        TEXT NOT NULL,
  transaction_id  TEXT NOT NULL,
  cloud_id        TEXT,
  cloud_deal_id   TEXT,
  content_hash    TEXT,
  hash_version    INTEGER,
  cloud_version   INTEGER,
  removed         INTEGER NOT NULL DEFAULT 0,
  last_status     TEXT,
  last_error_code TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (project_ref, owner_user_id, entity, local_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_dirty (
  transaction_id  TEXT PRIMARY KEY,
  generation      INTEGER NOT NULL,
  marked_at       TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT
);
CREATE TABLE IF NOT EXISTS cloud_sync_runs (
  id            INTEGER PRIMARY KEY,
  project_ref   TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  outcome       TEXT,
  deals_done    INTEGER NOT NULL DEFAULT 0,
  deals_failed  INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT
);`;

export const CLOUD_SYNC_TABLES = [
  "cloud_sync_install",
  "cloud_sync_settings",
  "cloud_sync_state",
  "cloud_sync_dirty",
  "cloud_sync_runs",
] as const;

// ---------------------------------------------------------------- triggers

const ENABLED_ROW = "SELECT 1 FROM cloud_sync_settings WHERE enabled = 1";
/** Child tables: any user with Keepr Cloud on (the pass filters by owner). */
const GATE = `WHEN EXISTS (${ENABLED_ROW})`;
/** transactions: only when the deal's owner has Keepr Cloud on. */
const OWNER_GATE = (owner: string) => `WHEN EXISTS (${ENABLED_ROW} AND user_id IN (${owner}))`;

function markBody(idExpr: string): string {
  return `INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at)
  SELECT ${idExpr}, 1, CURRENT_TIMESTAMP WHERE ${idExpr} IS NOT NULL
  ON CONFLICT (transaction_id) DO UPDATE SET generation = generation + 1, marked_at = excluded.marked_at;`;
}

/** Columns of `transactions` whose change marks the deal: the projection's own list plus user_id. */
export const DEAL_TRIGGER_COLUMNS: readonly string[] = [
  ...DEAL_SOURCE_COLUMNS.filter((c) => c !== "id"),
  "user_id",
];

export interface CloudSyncTriggerSpec {
  name: string;
  /** Table the trigger is on. */
  table: string;
  /** Every table and column the trigger names (checked before it is created). */
  requires: Record<string, readonly string[]>;
  sql: string;
}

function spec(
  name: string,
  table: string,
  event: string,
  body: string,
  requires: Record<string, readonly string[]>,
  gate: string = GATE,
): CloudSyncTriggerSpec {
  return {
    name,
    table,
    requires: {
      cloud_sync_settings: ["enabled", "user_id"],
      cloud_sync_dirty: ["transaction_id", "generation", "marked_at"],
      ...requires,
    },
    sql: `CREATE TRIGGER ${name}\nAFTER ${event} ON ${table}\n${gate}\nBEGIN\n  ${body}\nEND;`,
  };
}

/** Marks two deals (a row that moved marks both); the second only when it differs. */
function markTwo(newExpr: string, oldExpr: string): string {
  return `${markBody(newExpr)}\n  INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at)
  SELECT ${oldExpr}, 1, CURRENT_TIMESTAMP WHERE ${oldExpr} IS NOT NULL AND ${oldExpr} IS NOT ${newExpr}
  ON CONFLICT (transaction_id) DO UPDATE SET generation = generation + 1, marked_at = excluded.marked_at;`;
}

/** Marks every deal the contact is a party on. */
function markByContact(contactExpr: string): string {
  return `INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at)
  SELECT tc.transaction_id, 1, CURRENT_TIMESTAMP FROM transaction_contacts tc
   WHERE tc.contact_id = ${contactExpr} AND tc.transaction_id IS NOT NULL
  ON CONFLICT (transaction_id) DO UPDATE SET generation = generation + 1, marked_at = excluded.marked_at;`;
}

/** Child columns whose change marks the deal: each projection's own source list. */
export const PARTY_TRIGGER_COLUMNS: readonly string[] = [...PARTY_ROW_COLUMNS.filter((c) => c !== "id"), "removed_reason"];
export const CHECKLIST_TRIGGER_COLUMNS: readonly string[] = CHECKLIST_SOURCE_COLUMNS.filter((c) => c !== "id");
export const ITEM_TRIGGER_COLUMNS: readonly string[] = ITEM_SOURCE_COLUMNS.filter((c) => c !== "id");

const ITEM_PARENT = (ref: "NEW" | "OLD") =>
  `(SELECT c.transaction_id FROM transaction_checklists c WHERE c.id = ${ref}.checklist_id)`;

export const CLOUD_SYNC_TRIGGERS: readonly CloudSyncTriggerSpec[] = [
  spec("trg_cloud_sync_tx_insert", "transactions", "INSERT", markBody("NEW.id"), { transactions: ["id", "user_id"] }, OWNER_GATE("NEW.user_id")),
  spec(
    "trg_cloud_sync_tx_update",
    "transactions",
    `UPDATE OF ${DEAL_TRIGGER_COLUMNS.join(", ")}`,
    markBody("NEW.id"),
    { transactions: ["id", ...DEAL_TRIGGER_COLUMNS] },
    OWNER_GATE("NEW.user_id, OLD.user_id"),
  ),
  spec("trg_cloud_sync_tx_delete", "transactions", "DELETE", markBody("OLD.id"), { transactions: ["id", "user_id"] }, OWNER_GATE("OLD.user_id")),
  spec("trg_cloud_sync_party_insert", "transaction_contacts", "INSERT", markBody("NEW.transaction_id"), {
    transaction_contacts: ["transaction_id"],
  }),
  spec(
    "trg_cloud_sync_party_update",
    "transaction_contacts",
    `UPDATE OF ${PARTY_TRIGGER_COLUMNS.join(", ")}`,
    markTwo("NEW.transaction_id", "OLD.transaction_id"),
    { transaction_contacts: ["transaction_id", ...PARTY_TRIGGER_COLUMNS] },
  ),
  spec("trg_cloud_sync_party_delete", "transaction_contacts", "DELETE", markBody("OLD.transaction_id"), {
    transaction_contacts: ["transaction_id"],
  }),
  spec("trg_cloud_sync_checklist_insert", "transaction_checklists", "INSERT", markBody("NEW.transaction_id"), {
    transaction_checklists: ["transaction_id"],
  }),
  spec(
    "trg_cloud_sync_checklist_update",
    "transaction_checklists",
    `UPDATE OF ${CHECKLIST_TRIGGER_COLUMNS.join(", ")}`,
    markTwo("NEW.transaction_id", "OLD.transaction_id"),
    { transaction_checklists: ["transaction_id", ...CHECKLIST_TRIGGER_COLUMNS] },
  ),
  spec("trg_cloud_sync_checklist_delete", "transaction_checklists", "DELETE", markBody("OLD.transaction_id"), {
    transaction_checklists: ["transaction_id"],
  }),
  spec("trg_cloud_sync_item_insert", "transaction_checklist_items", "INSERT", markBody(ITEM_PARENT("NEW")), {
    transaction_checklist_items: ["checklist_id"],
    transaction_checklists: ["id", "transaction_id"],
  }),
  spec(
    "trg_cloud_sync_item_update",
    "transaction_checklist_items",
    `UPDATE OF ${ITEM_TRIGGER_COLUMNS.join(", ")}`,
    markTwo(ITEM_PARENT("NEW"), ITEM_PARENT("OLD")),
    { transaction_checklist_items: ["checklist_id", ...ITEM_TRIGGER_COLUMNS], transaction_checklists: ["id", "transaction_id"] },
  ),
  spec("trg_cloud_sync_item_delete", "transaction_checklist_items", "DELETE", markBody(ITEM_PARENT("OLD")), {
    transaction_checklist_items: ["checklist_id"],
    transaction_checklists: ["id", "transaction_id"],
  }),
  // People on deals: a change to the person marks every deal the person is on.
  spec(
    "trg_cloud_sync_contact_update",
    "contacts",
    `UPDATE OF ${PARTY_CONTACT_COLUMNS.join(", ")}`,
    markByContact("NEW.id"),
    { contacts: ["id", ...PARTY_CONTACT_COLUMNS], transaction_contacts: ["transaction_id", "contact_id"] },
    `${GATE}\n  AND (${PARTY_CONTACT_COLUMNS.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")})`,
  ),
  ...(
    [
      ["contact_emails", PARTY_EMAIL_COLUMNS],
      ["contact_phones", PARTY_PHONE_COLUMNS],
      ["contact_source_links", PARTY_SOURCE_LINK_COLUMNS],
    ] as const
  ).flatMap(([table, cols]) => [
    spec(`trg_cloud_sync_${table}_insert`, table, "INSERT", markByContact("NEW.contact_id"), {
      [table]: cols,
      transaction_contacts: ["transaction_id", "contact_id"],
    }),
    spec(
      `trg_cloud_sync_${table}_update`,
      table,
      `UPDATE OF ${cols.join(", ")}`,
      `${markByContact("NEW.contact_id")}\n  ${markByContact("OLD.contact_id")}`,
      { [table]: cols, transaction_contacts: ["transaction_id", "contact_id"] },
    ),
    spec(`trg_cloud_sync_${table}_delete`, table, "DELETE", markByContact("OLD.contact_id"), {
      [table]: cols,
      transaction_contacts: ["transaction_id", "contact_id"],
    }),
  ]),
];

// ---------------------------------------------------------------- engine statements

/** Same rule as the server's is_confirmed and transactionOpenSql.ts:66-67. */
export const ELIGIBLE_DEAL_WHERE = `(t.status IS NULL OR t.status <> 'rejected')
   AND (t.detection_status IS NULL OR t.detection_status NOT IN ('pending', 'rejected'))`;

/** Marks every eligible deal of every user with Keepr Cloud enabled on this computer. */
export const MARK_ALL_ELIGIBLE_ENABLED_SQL = `INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at)
SELECT t.id, 1, CURRENT_TIMESTAMP FROM transactions t
 WHERE t.user_id IN (SELECT s.user_id FROM cloud_sync_settings s WHERE s.enabled = 1)
   AND ${ELIGIBLE_DEAL_WHERE}
ON CONFLICT (transaction_id) DO UPDATE SET generation = generation + 1, marked_at = excluded.marked_at`;

/** Marks every eligible deal of one user. */
export const MARK_ALL_ELIGIBLE_FOR_USER_SQL = `INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at)
SELECT t.id, 1, CURRENT_TIMESTAMP FROM transactions t
 WHERE t.user_id = ? AND ${ELIGIBLE_DEAL_WHERE}
ON CONFLICT (transaction_id) DO UPDATE SET generation = generation + 1, marked_at = excluded.marked_at`;

/**
 * Dirty rows due now for one user, oldest mark first: that user's deals, and
 * deleted deals no other user has a sync record for. Another user's marks are
 * never selected (they wait for that user's own pass). A row parked by a non-retryable
 * failure (`<far future>#<generation>`) is due again once a new write bumped
 * its generation.
 */
export const SELECT_DUE_DIRTY_SQL = `SELECT d.transaction_id, d.generation, d.attempts
  FROM cloud_sync_dirty d
  LEFT JOIN transactions t ON t.id = d.transaction_id
 WHERE (t.user_id = ?
        OR (t.id IS NULL AND NOT EXISTS (
              SELECT 1 FROM cloud_sync_state s
               WHERE s.transaction_id = d.transaction_id AND s.owner_user_id <> ?)))
   AND (d.next_attempt_at IS NULL
        OR d.next_attempt_at <= ?
        OR (d.next_attempt_at LIKE '9999-12-31T00:00:00.000Z#%'
            AND d.next_attempt_at <> '9999-12-31T00:00:00.000Z#' || d.generation))
 ORDER BY d.marked_at ASC, d.rowid ASC
 LIMIT ?`;

export const SELECT_DEAL_FOR_PASS_SQL = `SELECT t.user_id AS user_id, t.updated_at AS updated_at, ${DEAL_SOURCE_COLUMNS.map((c) => `t.${c}`).join(", ")}
  FROM transactions t WHERE t.id = ?`;

/** Clears a mark only when no write landed since the pass read it (R4). */
export const DELETE_DIRTY_IF_GENERATION_SQL = `DELETE FROM cloud_sync_dirty WHERE transaction_id = ? AND generation = ?`;

/** After a successful upload whose mark was re-marked meanwhile: drop the failure columns. */
export const RESET_DIRTY_FAILURE_SQL = `UPDATE cloud_sync_dirty
   SET attempts = 0, next_attempt_at = NULL, last_error_code = NULL
 WHERE transaction_id = ?`;

/** Records a failure on the mark; never touches the generation. */
export const UPDATE_DIRTY_FAILURE_SQL = `UPDATE cloud_sync_dirty
   SET attempts = attempts + 1, next_attempt_at = ?, last_error_code = ?
 WHERE transaction_id = ?`;

export const SELECT_DEAL_STATE_SQL = `SELECT * FROM cloud_sync_state
 WHERE project_ref = ? AND owner_user_id = ? AND entity = 'deal' AND local_id = ?`;

export const UPSERT_DEAL_STATE_SQL = `INSERT INTO cloud_sync_state
  (project_ref, owner_user_id, entity, local_id, transaction_id, cloud_id, cloud_deal_id, content_hash,
   hash_version, cloud_version, removed, last_status, last_error_code, updated_at)
VALUES (?, ?, 'deal', ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
ON CONFLICT (project_ref, owner_user_id, entity, local_id) DO UPDATE SET
  cloud_id = excluded.cloud_id, cloud_deal_id = excluded.cloud_deal_id, content_hash = excluded.content_hash,
  hash_version = excluded.hash_version, cloud_version = excluded.cloud_version, removed = 0,
  last_status = excluded.last_status, last_error_code = NULL, updated_at = excluded.updated_at`;

export const DELETE_STATE_FOR_DEAL_SQL = `DELETE FROM cloud_sync_state
 WHERE project_ref = ? AND owner_user_id = ? AND transaction_id = ?`;

export const DELETE_STATE_FOR_USER_SQL = `DELETE FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id = ?`;

/** After a restore: nothing recorded as saved is trusted; cloud ids are kept for deletes. */
export const RESET_STATE_AFTER_RESTORE_SQL = `UPDATE cloud_sync_state SET content_hash = NULL, last_status = NULL`;

/** Marks of one user's deals that will not be retried until the deal changes (parked). */
export const COUNT_PARKED_FOR_USER_SQL = `SELECT COUNT(*) AS n FROM cloud_sync_dirty d JOIN transactions t ON t.id = d.transaction_id
 WHERE t.user_id = ? AND d.next_attempt_at LIKE '9999-12-31T00:00:00.000Z#%'
   AND d.next_attempt_at = '9999-12-31T00:00:00.000Z#' || d.generation`;

/** Marks of one user's deals still to be sent (not parked). */
export const COUNT_PENDING_FOR_USER_SQL = `SELECT COUNT(*) AS n FROM cloud_sync_dirty d JOIN transactions t ON t.id = d.transaction_id
 WHERE t.user_id = ? AND NOT (d.next_attempt_at IS NOT NULL AND d.next_attempt_at LIKE '9999-12-31T00:00:00.000Z#%'
   AND d.next_attempt_at = '9999-12-31T00:00:00.000Z#' || d.generation)`;

// ---------------------------------------------------------------- children (PR-3)

const PARTY_CONTACT_IDS = `SELECT tc.contact_id FROM transaction_contacts tc WHERE tc.transaction_id = ?`;

export const SELECT_PARTY_ROWS_SQL = `SELECT ${PARTY_ROW_COLUMNS.map((c) => `tc.${c}`).join(", ")}
  FROM transaction_contacts tc WHERE tc.transaction_id = ? ORDER BY tc.id`;
export const SELECT_PARTY_CONTACTS_SQL = `SELECT c.id, ${PARTY_CONTACT_COLUMNS.map((c) => `c.${c}`).join(", ")}
  FROM contacts c WHERE c.id IN (${PARTY_CONTACT_IDS})`;
export const SELECT_PARTY_EMAILS_SQL = `SELECT e.id, ${PARTY_EMAIL_COLUMNS.map((c) => `e.${c}`).join(", ")}
  FROM contact_emails e WHERE e.contact_id IN (${PARTY_CONTACT_IDS})`;
export const SELECT_PARTY_PHONES_SQL = `SELECT p.id, ${PARTY_PHONE_COLUMNS.map((c) => `p.${c}`).join(", ")}
  FROM contact_phones p WHERE p.contact_id IN (${PARTY_CONTACT_IDS})`;
export const SELECT_PARTY_SOURCE_LINKS_SQL = `SELECT ${PARTY_SOURCE_LINK_COLUMNS.map((c) => `l.${c}`).join(", ")}
  FROM contact_source_links l WHERE l.contact_id IN (${PARTY_CONTACT_IDS})`;
export const SELECT_CHECKLIST_ROWS_SQL = `SELECT ${CHECKLIST_SOURCE_COLUMNS.map((c) => `c.${c}`).join(", ")}
  FROM transaction_checklists c WHERE c.transaction_id = ? ORDER BY c.sort_order, c.id`;
export const SELECT_ITEM_ROWS_SQL = `SELECT ${ITEM_SOURCE_COLUMNS.map((c) => `i.${c}`).join(", ")}
  FROM transaction_checklist_items i JOIN transaction_checklists c ON c.id = i.checklist_id
 WHERE c.transaction_id = ? ORDER BY i.checklist_id, i.sort_order, i.id`;

/** Child state rows of one deal, plus any row of these local ids recorded under another deal (a move). */
export const SELECT_CHILD_STATE_SQL = `SELECT entity, local_id, transaction_id, cloud_id, content_hash, hash_version, removed, last_status
  FROM cloud_sync_state
 WHERE project_ref = ? AND owner_user_id = ? AND entity IN ('party', 'checklist', 'checklist_item')
   AND transaction_id = ?`;
export const SELECT_CHILD_STATE_BY_LOCAL_SQL = `SELECT entity, local_id, transaction_id, cloud_id, content_hash, hash_version, removed, last_status
  FROM cloud_sync_state
 WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?`;

export const UPSERT_CHILD_STATE_SQL = `INSERT INTO cloud_sync_state
  (project_ref, owner_user_id, entity, local_id, transaction_id, cloud_id, cloud_deal_id, content_hash,
   hash_version, cloud_version, removed, last_status, last_error_code, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'saved', NULL, ?)
ON CONFLICT (project_ref, owner_user_id, entity, local_id) DO UPDATE SET
  transaction_id = excluded.transaction_id, cloud_id = excluded.cloud_id, cloud_deal_id = excluded.cloud_deal_id,
  content_hash = excluded.content_hash, hash_version = excluded.hash_version, cloud_version = excluded.cloud_version,
  removed = 0, last_status = 'saved', last_error_code = NULL, updated_at = excluded.updated_at`;

/** A tombstone the server answered removed / unchanged / not_found: the row is gone online. */
export const MARK_CHILD_REMOVED_SQL = `UPDATE cloud_sync_state SET removed = 1, last_status = 'removed', updated_at = ?
 WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?`;

/** Forget one child's recorded hash so it is sent again (parent repair, reconcile). */
export const NULL_CHILD_HASH_SQL = `UPDATE cloud_sync_state SET content_hash = NULL, last_status = NULL
 WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?`;

// ---------------------------------------------------------------- reconcile (PR-3)

/** The user's eligible deals. */
export const SELECT_ELIGIBLE_DEAL_IDS_SQL = `SELECT t.id FROM transactions t WHERE t.user_id = ? AND ${ELIGIBLE_DEAL_WHERE}`;

/** Every state row of the user in this project (the reconcile's local record of what was uploaded). */
export const SELECT_USER_STATE_SQL = `SELECT entity, local_id, transaction_id, cloud_id, content_hash, removed
  FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id = ?`;

/** Forget a recorded hash (the online copy is missing or differs). */
export const NULL_STATE_HASH_BY_CLOUD_ID_SQL = `UPDATE cloud_sync_state SET content_hash = NULL, last_status = NULL
 WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?`;

/** Mark one deal for the reconcile (runs under the pass lock: an existing mark is left as it is). */
export const MARK_DEAL_SQL = `INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at)
VALUES (?, 1, CURRENT_TIMESTAMP)
ON CONFLICT (transaction_id) DO NOTHING`;

/** Un-park the user's parked marks so the next pass retries them. */
export const UNPARK_USER_MARKS_SQL = `UPDATE cloud_sync_dirty SET attempts = 0, next_attempt_at = NULL
 WHERE next_attempt_at LIKE '9999-12-31T00:00:00.000Z#%'
   AND transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)`;

const UNSENT = (table: string, entity: string, live: string, dealCol: string, join: string) =>
  `SELECT DISTINCT t.id FROM ${table} x ${join} JOIN transactions t ON t.id = ${dealCol}
    WHERE t.user_id = ? AND ${live}
      AND NOT EXISTS (SELECT 1 FROM cloud_sync_state s WHERE s.project_ref = ? AND s.owner_user_id = ?
                       AND s.entity = '${entity}' AND s.local_id = x.id AND s.removed = 0)`;

/** Eligible deals with a live child that has no live sync record. */
export const SELECT_DEALS_WITH_UNSENT_CHILDREN_SQL = `SELECT id FROM (
  ${UNSENT("transaction_contacts", "party", "x.removed_at IS NULL", "x.transaction_id", "")}
  UNION ${UNSENT("transaction_checklists", "checklist", "1 = 1", "x.transaction_id", "")}
  UNION ${UNSENT("transaction_checklist_items", "checklist_item", "1 = 1", "c.transaction_id", "JOIN transaction_checklists c ON c.id = x.checklist_id")}
) u WHERE u.id IN (SELECT t.id FROM transactions t WHERE ${ELIGIBLE_DEAL_WHERE})`;

/** Reconcile adoption: record an online deal's cloud id for a local deal with no record (hash unknown). */
export const ADOPT_DEAL_STATE_SQL = `INSERT INTO cloud_sync_state
  (project_ref, owner_user_id, entity, local_id, transaction_id, cloud_id, cloud_deal_id, content_hash,
   hash_version, cloud_version, removed, last_status, last_error_code, updated_at)
VALUES (?, ?, 'deal', ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, ?)
ON CONFLICT (project_ref, owner_user_id, entity, local_id) DO NOTHING`;

/** R1: a row that needs the dirty-mark triggers (Keepr Cloud on, or a turn-off still owed). */
export const CLOUD_SYNC_ACTIVE_SQL = `SELECT 1 FROM cloud_sync_settings WHERE enabled = 1 OR turn_off_owed_at IS NOT NULL LIMIT 1`;
