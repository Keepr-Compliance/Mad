/**
 * Local reads behind the todo screens — BACKLOG-4263 PR-6.
 *
 * Read-only except `dismissTodoNotice` (one UPDATE of this user's own notice). Nothing here writes a todo, a
 * shadow, `changed_json` or an outbox row: the screens change todos only through the existing checklist
 * channels (whose capture triggers record the op) and the server's restore (whose result arrives by the pull).
 */
import type { SqlDb } from "./cloudSyncSqlDb";

export interface NoticeRow {
  id: number;
  entity: string;
  local_id: string;
  part: string | null;
  kind: string;
  transaction_id: string | null;
  other_json: string | null;
  actor_kind: string | null;
  actor_label: string | null;
  created_at: string;
}

export interface MarkerRow {
  local_id: string;
  changed_json: string;
}

function hasColumn(db: SqlDb, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

/** Keepr Cloud is on for this user on this computer (the rule the deal archive uses: `enabled = 1`). No network. */
export function cloudOnForUser(db: SqlDb, projectRef: string, userId: string): boolean {
  const r = db
    .prepare("SELECT enabled FROM cloud_sync_settings WHERE project_ref = ? AND user_id = ?")
    .get(projectRef, userId) as { enabled: number } | undefined;
  return r?.enabled === 1;
}

/** The deal is this user's. */
export function dealOwnedBy(db: SqlDb, transactionId: string, userId: string): boolean {
  const r = db.prepare("SELECT user_id FROM transactions WHERE id = ?").get(transactionId) as { user_id: string } | undefined;
  return !!r && r.user_id === userId;
}

/**
 * The local item a notice is about. A notice written before its todo's shadow existed (a turn-on or reclaim pull)
 * holds the CLOUD id in `local_id` (pr4b-sr-review-2 §3): resolve it through the shadow by `cloud_id`.
 */
export function resolveNoticeItem(db: SqlDb, projectRef: string, userId: string, entity: string, id: string): string | null {
  const table = entity === "checklist" ? "transaction_checklists" : "transaction_checklist_items";
  if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
  const sh = db
    .prepare("SELECT local_id FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND cloud_id = ?")
    .get(projectRef, userId, entity, id) as { local_id: string } | undefined;
  return sh?.local_id ?? null;
}

/** This user's notices not dismissed, for one deal, oldest first (at most 200). */
export function noticesForDeal(db: SqlDb, projectRef: string, userId: string, transactionId: string): NoticeRow[] {
  return db
    .prepare(
      `SELECT id, entity, local_id, part, kind, transaction_id, other_json, actor_kind, actor_label, created_at
         FROM cloud_sync_todo_notices
        WHERE project_ref = ? AND owner_user_id = ? AND transaction_id = ? AND dismissed_at IS NULL
        ORDER BY id LIMIT 200`,
    )
    .all(projectRef, userId, transactionId) as NoticeRow[];
}

/** Dismisses one of this user's notices. True when a row changed. */
export function dismissTodoNotice(db: SqlDb, projectRef: string, userId: string, id: number, now: Date): boolean {
  const r = db
    .prepare("UPDATE cloud_sync_todo_notices SET dismissed_at = ? WHERE id = ? AND project_ref = ? AND owner_user_id = ? AND dismissed_at IS NULL")
    .run(now.toISOString(), id, projectRef, userId) as { changes?: number };
  return (r.changes ?? 0) > 0;
}

/** The AI-app markers of one deal's items (read only; v84 column, absent on an older file). */
export function markersForDeal(db: SqlDb, projectRef: string, userId: string, transactionId: string): MarkerRow[] {
  if (!hasColumn(db, "cloud_sync_todo_state", "changed_json")) return [];
  return db
    .prepare(
      `SELECT local_id, changed_json FROM cloud_sync_todo_state
        WHERE project_ref = ? AND owner_user_id = ? AND entity = 'item' AND transaction_id = ? AND changed_json IS NOT NULL`,
    )
    .all(projectRef, userId, transactionId) as MarkerRow[];
}

/** The online id of a local todo (its shadow), or null when it is not online yet. */
export function cloudIdOf(db: SqlDb, projectRef: string, userId: string, entity: "item" | "checklist", localId: string): string | null {
  const r = db
    .prepare("SELECT cloud_id FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?")
    .get(projectRef, userId, entity, localId) as { cloud_id: string | null } | undefined;
  return r?.cloud_id ?? null;
}

/** The local deal this user's sync record maps an online deal id to, or null. */
export function localDealIdOf(db: SqlDb, projectRef: string, userId: string, cloudDealId: string): string | null {
  const r = db
    .prepare("SELECT local_id FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id = ? AND entity = 'deal' AND cloud_id = ?")
    .get(projectRef, userId, cloudDealId) as { local_id: string } | undefined;
  return r?.local_id ?? null;
}

/** The local deal an item belongs to, or null. */
export function dealOfItem(db: SqlDb, itemId: string): string | null {
  const r = db
    .prepare("SELECT c.transaction_id AS t FROM transaction_checklist_items i JOIN transaction_checklists c ON c.id = i.checklist_id WHERE i.id = ?")
    .get(itemId) as { t: string } | undefined;
  return r?.t ?? null;
}

/** The online id of a local deal (this user's sync record), or null. */
export function cloudDealIdOf(db: SqlDb, projectRef: string, userId: string, transactionId: string): string | null {
  const r = db
    .prepare("SELECT cloud_id FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id = ? AND entity = 'deal' AND local_id = ?")
    .get(projectRef, userId, transactionId) as { cloud_id: string | null } | undefined;
  return r?.cloud_id ?? null;
}

/** The title and current values of a local item (for a notice's "other version"), or null. */
export function itemValues(db: SqlDb, itemId: string): Record<string, unknown> | null {
  return (
    (db
      .prepare("SELECT title, note, due_date, is_checked FROM transaction_checklist_items WHERE id = ?")
      .get(itemId) as Record<string, unknown> | undefined) ?? null
  );
}

/**
 * This user's parked rows: those waiting for a locked deal, and the rest. Not counted: `deal_unknown`, the todos of
 * a deal that is not on this computer (for example one restored online only): nothing here is waiting for them.
 */
export function parkedCounts(db: SqlDb, projectRef: string, userId: string): { locked: number; other: number } {
  const rows = db
    .prepare(
      `SELECT error_code = 'deal_locked' AS locked, COUNT(*) AS n FROM cloud_sync_todo_parked
        WHERE project_ref = ? AND owner_user_id = ? AND coalesce(error_code, '') <> 'deal_unknown' GROUP BY 1`,
    )
    .all(projectRef, userId) as Array<{ locked: number; n: number }>;
  return {
    locked: rows.find((r) => r.locked === 1)?.n ?? 0,
    other: rows.find((r) => r.locked !== 1)?.n ?? 0,
  };
}

/** A local deal's state for the Removed list: absent, rejected, or present. */
export function localDealState(db: SqlDb, transactionId: string, userId: string): "absent" | "rejected" | "present" {
  const r = db
    .prepare("SELECT user_id, detection_status FROM transactions WHERE id = ?")
    .get(transactionId) as { user_id: string; detection_status: string | null } | undefined;
  if (!r || r.user_id !== userId) return "absent";
  return r.detection_status === "rejected" ? "rejected" : "present";
}
