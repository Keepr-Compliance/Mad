/**
 * Keepr Cloud todos, local reads and writes — BACKLOG-4263 PR-4a (plan §2.2 scan, §3.2, §3.4; plan
 * check D6, E4, R3, R4; PR-3 review N1–N3, N5).
 *
 * Every function here is synchronous: each write is one better-sqlite3 transaction with no `await`
 * inside (R4), so nothing else on the connection can run inside it. Nothing here makes a network call.
 *
 * The tables (cloudSyncTodoSql.ts): outbox (ops to send), state (the shadow: what the cloud last said,
 * per part, with its rev), cursor (`full_pull_owed`), parked, notices, trash, counter (per install:
 * edit_seq, epoch), and cloud_sync_applying (the apply guard).
 */
import type { JsonValue } from "../cloudSync/jcs";
import type { SqlDb } from "./cloudSyncSqlDb";
import { checklistJson, CLOCK_STEP_SECONDS, itemJson, SEED_TODO_COUNTER_SQL } from "./cloudSyncTodoSql";
import type { AnswerAction } from "../cloudSync/todos/answers";
import { TRANSACTION_SUBMISSION_STATUS_SQL } from "./core/transactionEligibilitySql";
import { dealLockReason } from "../transactionEligibility";
import {
  isPart,
  ITEM_PARTS,
  PART_COLUMNS,
  partColumns,
  partsOfCreate,
  partValue,
  samePart,
  SCAN_EPOCH,
  type OutboxRow,
  type TodoPart,
} from "../cloudSync/todos/wire";

/** The per-user todo tables (D6). The counter is per install and goes only on a rebind. */
export const TODO_USER_TABLES = [
  "cloud_sync_todo_outbox",
  "cloud_sync_todo_state",
  "cloud_sync_todo_cursor",
  "cloud_sync_todo_parked",
  "cloud_sync_todo_notices",
  "cloud_sync_todo_trash",
] as const;

const STATE_PARTS = ["done", "title", "note", "due", "order", "removed"] as const;
type StatePart = (typeof STATE_PARTS)[number];

function hasTable(db: SqlDb, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function hasColumn(db: SqlDb, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

// ---------------------------------------------------------------- clearing (D6, N3, E1)

/** Every per-user todo row of this user in this project, and the user's stop (E1). */
export function clearTodoStateForUser(db: SqlDb, projectRef: string, userId: string): void {
  if (!hasTable(db, "cloud_sync_todo_outbox")) return;
  db.transaction(() => {
    for (const t of TODO_USER_TABLES) db.prepare(`DELETE FROM ${t} WHERE project_ref = ? AND owner_user_id = ?`).run(projectRef, userId);
    if (hasColumn(db, "cloud_sync_settings", "install_removed_at")) {
      db.prepare("UPDATE cloud_sync_settings SET install_removed_at = NULL WHERE project_ref = ? AND user_id = ?").run(projectRef, userId);
    }
  })();
}

/** The machine rebind (D6): every user's todo rows, every counter row, every stop. */
export function clearTodoStateEverywhere(db: SqlDb): void {
  if (!hasTable(db, "cloud_sync_todo_outbox")) return;
  db.transaction(() => {
    for (const t of TODO_USER_TABLES) db.exec(`DELETE FROM ${t}`);
    db.exec("DELETE FROM cloud_sync_todo_counter");
    if (hasColumn(db, "cloud_sync_settings", "install_removed_at")) db.exec("UPDATE cloud_sync_settings SET install_removed_at = NULL");
  })();
}

/** forgetOtherProjects: the other projects' todo rows. */
export function forgetTodoOtherProjects(db: SqlDb, projectRef: string): void {
  if (!hasTable(db, "cloud_sync_todo_outbox")) return;
  db.transaction(() => {
    for (const t of [...TODO_USER_TABLES, "cloud_sync_todo_counter"]) db.prepare(`DELETE FROM ${t} WHERE project_ref <> ?`).run(projectRef);
  })();
}

/** N5: the apply guard exists only inside a confirm transaction; at open it is always cleared. */
export function clearApplyGuard(db: SqlDb): void {
  try {
    if (hasTable(db, "cloud_sync_applying")) db.exec("DELETE FROM cloud_sync_applying");
  } catch {
    /* never blocks an open */
  }
}

// ---------------------------------------------------------------- cursor and the scan gate (E4)

export interface TodoCursor {
  last_seq: number;
  full_pull_owed: number;
  /** PR-4b (v82): the horizon stored with last_seq; null before the first applied page. */
  horizon?: number | null;
  /** PR-4b (v82): 'restore' while the full pull owed after a backup restore has not finished. */
  full_pull_kind?: string | null;
}

export function getTodoCursor(db: SqlDb, projectRef: string, userId: string): TodoCursor | null {
  const r = db.prepare("SELECT * FROM cloud_sync_todo_cursor WHERE project_ref = ? AND owner_user_id = ?").get(projectRef, userId) as
    | (TodoCursor & Record<string, unknown>)
    | undefined;
  if (!r) return null;
  return { last_seq: r.last_seq, full_pull_owed: r.full_pull_owed, horizon: r.horizon ?? null, full_pull_kind: r.full_pull_kind ?? null };
}

/**
 * E4: the scan (daily, after a versioned migration, after a trigger repair, after a restore) never runs
 * while a full pull is owed. On a 4a build nothing pulls, so this stays false after turn-on and after a
 * restore; only the initial scans (turn-on, the one-time N1a step, a deal the cloud lost) bypass it, and
 * they run against an empty shadow with unknowable times.
 */
export function todoScanAllowed(db: SqlDb, projectRef: string, userId: string): boolean {
  const c = getTodoCursor(db, projectRef, userId);
  return c !== null && c.full_pull_owed === 0;
}

/**
 * A full pull from 0 is owed (contract `pull.cursor`: it starts with no horizon). `kind` 'restore' (after a
 * backup restore) makes the cloud's values win in that pull; NULL (turn-on, the one-time step, an account reset)
 * keeps a part this computer wrote last (PR-4b, see cloudSyncTodoPullDb.ts; 'resync' is set only by
 * resetTodoCursorForFullPull). Callers pass the kind; startTodoTracking keeps a 'restore' still owed.
 */
export function writeCursorOwed(db: SqlDb, projectRef: string, userId: string, now: Date, kind: "restore" | "behind" | null = null): void {
  if (hasColumn(db, "cloud_sync_todo_cursor", "horizon")) {
    db.prepare(
      `INSERT INTO cloud_sync_todo_cursor (project_ref, owner_user_id, last_seq, full_pull_owed, updated_at, horizon, full_pull_kind) VALUES (?, ?, 0, 1, ?, NULL, ?)
       ON CONFLICT (project_ref, owner_user_id) DO UPDATE SET last_seq = 0, full_pull_owed = 1, updated_at = excluded.updated_at,
         horizon = NULL, full_pull_kind = excluded.full_pull_kind`,
    ).run(projectRef, userId, now.toISOString(), kind);
    return;
  }
  db.prepare(
    `INSERT INTO cloud_sync_todo_cursor (project_ref, owner_user_id, last_seq, full_pull_owed, updated_at) VALUES (?, ?, 0, 1, ?)
     ON CONFLICT (project_ref, owner_user_id) DO UPDATE SET last_seq = 0, full_pull_owed = 1, updated_at = excluded.updated_at`,
  ).run(projectRef, userId, now.toISOString());
}

// ---------------------------------------------------------------- counter (R3, E2, N1b)

export function currentInstallId(db: SqlDb, projectRef: string): string | null {
  const r = db.prepare("SELECT install_id FROM cloud_sync_install WHERE project_ref = ?").get(projectRef) as { install_id: string } | undefined;
  return r?.install_id ?? null;
}

/** N1b: this computer's counter row, created when absent (a profile turned on before it existed has none). */
export function seedTodoCounter(db: SqlDb, projectRef: string): void {
  db.prepare(SEED_TODO_COUNTER_SQL).run(projectRef);
}

/**
 * E2, the runner's half: the same epoch test the capture trigger runs, at the start of a pass and before
 * each send. Returns the epoch now (null without a counter row).
 */
export function stepTodoEpoch(db: SqlDb, projectRef: string, now: Date): number | null {
  const install = currentInstallId(db, projectRef);
  if (!install) return null;
  const t = now.toISOString();
  const stepped = `(julianday(max_wall_seen) IS NOT NULL AND julianday(?) < julianday(max_wall_seen) - ${CLOCK_STEP_SECONDS}.0 / 86400.0)`;
  db.prepare(
    `UPDATE cloud_sync_todo_counter
        SET clock_epoch = clock_epoch + (CASE WHEN ${stepped} THEN 1 ELSE 0 END),
            max_wall_seen = CASE WHEN julianday(max_wall_seen) IS NULL OR ${stepped} OR julianday(?) > julianday(max_wall_seen)
                                 THEN ? ELSE max_wall_seen END
      WHERE project_ref = ? AND install_id = ?`,
  ).run(t, t, t, t, projectRef, install);
  const r = db
    .prepare("SELECT clock_epoch FROM cloud_sync_todo_counter WHERE project_ref = ? AND install_id = ?")
    .get(projectRef, install) as { clock_epoch: number } | undefined;
  return r ? r.clock_epoch : null;
}

/**
 * One edit_seq for a scan op (absent counter: NULL, compared by time, N1b). After a restore the counter is
 * the backup's (rewound, R3) until a pull raises it (PR-4b), so a scan op could carry a number above one this
 * computer stored online for a NEWER value before the restore, and win through the same-install arm: while
 * the counter is rewound, scan ops carry no edit_seq (with their unknowable time they then never win).
 */
export function nextEditSeq(db: SqlDb, projectRef: string): number | null {
  const install = currentInstallId(db, projectRef);
  if (!install) return null;
  const k = db.prepare("SELECT rewound_at FROM cloud_sync_todo_counter WHERE project_ref = ? AND install_id = ?").get(projectRef, install) as
    | { rewound_at: string | null }
    | undefined;
  if (k?.rewound_at) return null;
  db.prepare("UPDATE cloud_sync_todo_counter SET edit_seq = edit_seq + 1 WHERE project_ref = ? AND install_id = ?").run(projectRef, install);
  const r = db.prepare("SELECT edit_seq FROM cloud_sync_todo_counter WHERE project_ref = ? AND install_id = ?").get(projectRef, install) as
    | { edit_seq: number }
    | undefined;
  return r ? r.edit_seq : null;
}

// ---------------------------------------------------------------- the scan (plan §2.2)

interface ShadowRow {
  cloud_id: string | null;
  cloud_deal_id: string | null;
  transaction_id: string | null;
  done_rev: number | null;
  done_json: string | null;
  title_rev: number | null;
  title_json: string | null;
  note_rev: number | null;
  note_json: string | null;
  due_rev: number | null;
  due_json: string | null;
  order_rev: number | null;
  order_json: string | null;
  removed_rev: number | null;
  removed_json: string | null;
}

function parseJson(s: string | null | undefined): JsonValue | undefined {
  if (s === null || s === undefined) return undefined;
  try {
    return JSON.parse(s) as JsonValue;
  } catch {
    return undefined;
  }
}

function shadowRemoved(st: Pick<ShadowRow, "removed_json">): boolean {
  const v = parseJson(st.removed_json);
  return !!v && typeof v === "object" && !Array.isArray(v) && (v as Record<string, JsonValue>).removed_at !== null && (v as Record<string, JsonValue>).removed_at !== undefined;
}

const STATE_COLS = "st.cloud_id, st.cloud_deal_id, st.transaction_id AS st_tx, " + STATE_PARTS.map((p) => `st.${p}_rev, st.${p}_json`).join(", ");

/**
 * Compares local checklists and items of this user (all deals, or `dealIds`) with the shadow and writes
 * one outbox op per difference, never replacing a row already waiting (ON CONFLICT DO NOTHING: an in-flight
 * row keeps its op_id). No shadow (or no cloud id) → a create op with the row's current values; a part whose
 * local value differs from the shadow → a set op with base_rev = the shadow's rev. Absence never removes: a
 * local row that is gone produces nothing here (its own BEFORE DELETE trigger records a removal; a deal
 * delete removes its todos through the deal).
 *
 * Every scan op has edited_at = scan time and clock_epoch = SCAN_EPOCH, so it is sent as clock_stepped
 * (its edit time is not known): it never wins a concurrent conflict by time.
 */
export function scanTodos(db: SqlDb, projectRef: string, userId: string, now: Date, dealIds?: readonly string[]): number {
  const dealFilter = dealIds ? `AND t.id IN (${dealIds.map(() => "?").join(", ") || "NULL"})` : "";
  const dealArgs = dealIds ? [...dealIds] : [];
  const pending = new Set(
    (db.prepare("SELECT entity, local_id, part FROM cloud_sync_todo_outbox WHERE project_ref = ? AND owner_user_id = ?").all(projectRef, userId) as Array<{
      entity: string;
      local_id: string;
      part: string;
    }>).map((r) => `${r.entity}|${r.local_id}|${r.part}`),
  );
  // PR-4b: a create the server answered with a kept refusal (a notice records it) is not queued again by a
  // later scan: an exact resend would be refused the same way every day.
  const refused = new Set(
    (db
      .prepare(
        `SELECT entity, local_id FROM cloud_sync_todo_notices WHERE project_ref = ? AND owner_user_id = ? AND part = 'create'
            AND kind IN ('rejected', 'not_allowed', 'not_restorable') AND dismissed_at IS NULL`,
      )
      .all(projectRef, userId) as Array<{ entity: string; local_id: string }>).map((r) => `${r.entity}|${r.local_id}`),
  );
  const at = now.toISOString();
  const insert = db.prepare(
    `INSERT INTO cloud_sync_todo_outbox
       (project_ref, owner_user_id, entity, local_id, part, transaction_id, value_json, base_rev, edit_seq, edited_at, clock_epoch, op_id, generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, lower(hex(randomblob(16))), 1)
     ON CONFLICT (project_ref, owner_user_id, entity, local_id, part) DO NOTHING`,
  );
  let n = 0;
  const add = (entity: string, localId: string, part: string, tx: string, value: string, baseRev: number | null) => {
    const key = `${entity}|${localId}|${part}`;
    if (pending.has(key)) return;
    if (part === "create" && refused.has(`${entity}|${localId}`)) return;
    // A part never goes out while its entity's create is still waiting: the create carries it.
    if (part !== "create" && pending.has(`${entity}|${localId}|create`)) return;
    insert.run(projectRef, userId, entity, localId, part, tx, value, baseRev, nextEditSeq(db, projectRef), at, SCAN_EPOCH);
    pending.add(key);
    n++;
  };
  return db.transaction(() => {
    const checklists = db
      .prepare(
        `SELECT c.id, c.transaction_id, c.sort_order, ${checklistJson("c")} AS create_json, ${STATE_COLS}
           FROM transaction_checklists c JOIN transactions t ON t.id = c.transaction_id
           LEFT JOIN cloud_sync_todo_state st ON st.project_ref = ? AND st.owner_user_id = ? AND st.entity = 'checklist' AND st.local_id = c.id
          WHERE t.user_id = ? ${dealFilter}
          ORDER BY c.transaction_id, c.sort_order, c.id`,
      )
      .all(projectRef, userId, userId, ...dealArgs) as Array<Record<string, unknown> & ShadowRow>;
    for (const c of checklists) {
      const id = String(c.id);
      const tx = String(c.transaction_id);
      if (!c.cloud_id) {
        add("checklist", id, "create", tx, String(c.create_json), null);
        continue;
      }
      if (shadowRemoved(c)) continue;
      if (!samePart("order", partValue("order", c), parseJson(c.order_json))) add("checklist", id, "order", tx, JSON.stringify({ sort_order: c.sort_order ?? null }), c.order_rev ?? null);
    }
    const items = db
      .prepare(
        `SELECT i.id, c.transaction_id, i.is_checked, i.checked_at, i.title, i.note, i.due_date, i.sort_order,
                ${itemJson("i")} AS create_json, ${STATE_COLS}
           FROM transaction_checklist_items i JOIN transaction_checklists c ON c.id = i.checklist_id
           JOIN transactions t ON t.id = c.transaction_id
           LEFT JOIN cloud_sync_todo_state st ON st.project_ref = ? AND st.owner_user_id = ? AND st.entity = 'item' AND st.local_id = i.id
          WHERE t.user_id = ? ${dealFilter}
          ORDER BY c.transaction_id, i.checklist_id, i.sort_order, i.id`,
      )
      .all(projectRef, userId, userId, ...dealArgs) as Array<Record<string, unknown> & ShadowRow>;
    for (const it of items) {
      const id = String(it.id);
      const tx = String(it.transaction_id);
      if (!it.cloud_id) {
        add("item", id, "create", tx, String(it.create_json), null);
        continue;
      }
      if (shadowRemoved(it)) continue;
      for (const p of ITEM_PARTS) {
        const shadow = parseJson(it[`${p}_json` as keyof ShadowRow] as string | null);
        if (samePart(p, partValue(p, it), shadow)) continue;
        const cols: Record<string, unknown> = {};
        for (const col of PART_COLUMNS[p]) cols[col] = it[col] ?? null;
        add("item", id, p, tx, JSON.stringify(cols), (it[`${p}_rev` as keyof ShadowRow] as number | null) ?? null);
      }
    }
    return n;
  })();
}

/** The gated scan (daily, after a migration or a trigger repair): refused while a full pull is owed (E4). */
export function scanTodosIfAllowed(db: SqlDb, projectRef: string, userId: string, now: Date): number {
  if (!todoScanAllowed(db, projectRef, userId)) return 0;
  return scanTodos(db, projectRef, userId, now);
}

/** Every enabled user's gated scan (after a versioned migration, after a trigger repair). */
export function scanTodosAllEnabled(db: SqlDb, now: Date): number {
  if (!hasTable(db, "cloud_sync_todo_cursor")) return 0;
  let n = 0;
  for (const s of db.prepare("SELECT project_ref, user_id FROM cloud_sync_settings WHERE enabled = 1").all() as Array<{ project_ref: string; user_id: string }>) {
    n += scanTodosIfAllowed(db, s.project_ref, s.user_id, now);
  }
  return n;
}

// ---------------------------------------------------------------- turn-on, the one-time step (N1a), a lost deal

/**
 * A fresh start for this user's todos, in the caller's transaction: clear every per-user todo row and the
 * old one-way records of checklists and items (N3), seed this computer's counter (N1b) and record that a full
 * pull is owed (D6). PR-4b order (PR-4a review C): no scan here. The pass pushes what is waiting, runs the full
 * pull (which records what the cloud already holds in the shadow), raises the counter, and only then scans
 * (cloudSyncTodoPullDb.applyTodoPage, last page). Returns 0 (no op is written here).
 */
export function startTodoTracking(db: SqlDb, projectRef: string, userId: string, now: Date): number {
  if (!hasTable(db, "cloud_sync_todo_outbox")) return 0;
  return db.transaction(() => {
    // A cloud-wins full pull still owed is never downgraded: an account reset or a reclaim on a restored file
    // ('restore', plan §3.4) or on a file found older than its own online history ('behind', which cannot be
    // detected again once its first page raised the counter) must still let the cloud win.
    const owedKind = getTodoCursor(db, projectRef, userId)?.full_pull_kind;
    const carried = owedKind === "restore" || owedKind === "behind" ? owedKind : null;
    clearTodoStateForUser(db, projectRef, userId);
    // PR-4b: an old one-way record of a checklist or item saved online whose local row is gone (deleted here,
    // the one-way removal never sent) becomes a removal op before the record goes, so the full pull does not
    // bring that todo back (the op waits for the pull, which records the todo's cloud id in the shadow).
    const at = now.toISOString();
    const gone = db
      .prepare(
        `SELECT s.entity, s.local_id, s.transaction_id FROM cloud_sync_state s
          WHERE s.project_ref = ? AND s.owner_user_id = ? AND s.entity IN ('checklist', 'checklist_item') AND s.cloud_id IS NOT NULL
            AND coalesce(s.removed, 0) = 0
            AND NOT EXISTS (SELECT 1 FROM transaction_checklists c WHERE s.entity = 'checklist' AND c.id = s.local_id)
            AND NOT EXISTS (SELECT 1 FROM transaction_checklist_items i WHERE s.entity = 'checklist_item' AND i.id = s.local_id)
            AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = s.transaction_id AND t.user_id = s.owner_user_id)`,
      )
      .all(projectRef, userId) as Array<{ entity: string; local_id: string; transaction_id: string }>;
    const removal = db.prepare(
      `INSERT INTO cloud_sync_todo_outbox
         (project_ref, owner_user_id, entity, local_id, part, transaction_id, value_json, base_rev, edit_seq, edited_at, clock_epoch, op_id, generation)
       VALUES (?, ?, ?, ?, 'removed', ?, '{"removed":1}', NULL, NULL, ?, NULL, lower(hex(randomblob(16))), 1)
       ON CONFLICT (project_ref, owner_user_id, entity, local_id, part) DO NOTHING`,
    );
    for (const g of gone) removal.run(projectRef, userId, g.entity === "checklist" ? "checklist" : "item", g.local_id, g.transaction_id, at);
    db.prepare("DELETE FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id = ? AND entity IN ('checklist', 'checklist_item')").run(
      projectRef,
      userId,
    );
    seedTodoCounter(db, projectRef);
    writeCursorOwed(db, projectRef, userId, now, carried);
    return 0;
  })();
}

/**
 * Before a pass sends anything, in the caller's transaction:
 * - N1a, once: an enabled user with no cursor row was turned on before this build (its outbox, trash and
 *   counter rows came from PR-3's triggers with nobody reading them). Drop counter rows of other install
 *   ids and start the user's todos afresh (startTodoTracking). The cursor row it writes is the marker:
 *   the step never runs again for this user.
 * - N1b: seed this computer's counter row when it is absent.
 */
export function prepareTodoPass(db: SqlDb, projectRef: string, userId: string, now: Date): { oneShot: boolean } {
  if (!hasTable(db, "cloud_sync_todo_cursor")) return { oneShot: false };
  return db.transaction(() => {
    const s = db.prepare("SELECT enabled FROM cloud_sync_settings WHERE project_ref = ? AND user_id = ?").get(projectRef, userId) as
      | { enabled: number }
      | undefined;
    let oneShot = false;
    if (s?.enabled === 1 && !getTodoCursor(db, projectRef, userId)) {
      db.prepare("DELETE FROM cloud_sync_todo_counter WHERE project_ref = ? AND install_id IS NOT (SELECT install_id FROM cloud_sync_install WHERE project_ref = ?)").run(
        projectRef,
        projectRef,
      );
      startTodoTracking(db, projectRef, userId, now);
      oneShot = true;
    }
    seedTodoCounter(db, projectRef);
    return { oneShot };
  })();
}

/**
 * The cloud lost this deal (it is uploaded again from scratch): forget its todo shadow and waiting ops, and
 * scan the deal against the empty shadow. Safe while a full pull is owed: the scan ops carry unknowable
 * times, so they win only against values this computer wrote.
 */
export function resetTodoDeal(db: SqlDb, projectRef: string, userId: string, transactionId: string, now: Date): number {
  if (!hasTable(db, "cloud_sync_todo_outbox")) return 0;
  return db.transaction(() => {
    db.prepare("DELETE FROM cloud_sync_todo_outbox WHERE project_ref = ? AND owner_user_id = ? AND transaction_id = ?").run(projectRef, userId, transactionId);
    db.prepare("DELETE FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND transaction_id = ?").run(projectRef, userId, transactionId);
    return scanTodos(db, projectRef, userId, now, [transactionId]);
  })();
}

/**
 * BACKLOG-4263 PR-4c: after a deal's header was saved under `cloudDealId`: when any todo record of the deal names
 * another online deal (the copy it was recorded against is gone), the deal is reset as resetTodoDeal does. Returns
 * the ops the reset queued (0 when nothing named another copy).
 */
export function resetTodoDealIfOtherCloudDeal(db: SqlDb, projectRef: string, userId: string, transactionId: string, cloudDealId: string, now: Date): number {
  if (!hasTable(db, "cloud_sync_todo_state")) return 0;
  const other = db
    .prepare(
      `SELECT 1 FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND transaction_id = ?
          AND cloud_deal_id IS NOT NULL AND cloud_deal_id <> ? LIMIT 1`,
    )
    .get(projectRef, userId, transactionId, cloudDealId);
  return other ? resetTodoDeal(db, projectRef, userId, transactionId, now) : 0;
}

// ---------------------------------------------------------------- backup restore (plan §3.4, E4)

/**
 * After this database was replaced by a restored copy (inside resetSyncStateAfterRestore's transaction):
 * - an enabled user with no cursor row (a backup from before this build): that user's PR-3-era rows are
 *   dropped and a cursor row is written with a full pull owed, so the one-time step never runs on a
 *   restored file and no scan sends the backup's values;
 * - every waiting op of an entity the cloud already has (a cloud id in the shadow) is dropped; creates of
 *   entities that never reached the cloud stay;
 * - every cursor owes a full pull from 0;
 * - the counter is marked rewound (R3: the next pull raises it; until then same-install ops are compared
 *   by time).
 */
export function resetTodosAfterRestore(db: SqlDb, now: Date): boolean {
  if (!hasTable(db, "cloud_sync_todo_outbox") || !hasTable(db, "cloud_sync_todo_cursor")) return false;
  db.transaction(() => {
    const at = now.toISOString();
    for (const s of db.prepare("SELECT project_ref, user_id FROM cloud_sync_settings WHERE enabled = 1").all() as Array<{ project_ref: string; user_id: string }>) {
      if (getTodoCursor(db, s.project_ref, s.user_id)) continue;
      for (const t of TODO_USER_TABLES) db.prepare(`DELETE FROM ${t} WHERE project_ref = ? AND owner_user_id = ?`).run(s.project_ref, s.user_id);
      writeCursorOwed(db, s.project_ref, s.user_id, now, "restore");
    }
    db.exec(`DELETE FROM cloud_sync_todo_outbox WHERE EXISTS (
      SELECT 1 FROM cloud_sync_todo_state st WHERE st.project_ref = cloud_sync_todo_outbox.project_ref
         AND st.owner_user_id = cloud_sync_todo_outbox.owner_user_id AND st.entity = cloud_sync_todo_outbox.entity
         AND st.local_id = cloud_sync_todo_outbox.local_id AND st.cloud_id IS NOT NULL)`);
    db.prepare("UPDATE cloud_sync_todo_cursor SET last_seq = 0, full_pull_owed = 1, updated_at = ?").run(at);
    // PR-4b: the full pull this owes is a restore pull (the cloud's values win), per user; the horizon goes with
    // the cursor (a full pull starts with none).
    if (hasColumn(db, "cloud_sync_todo_cursor", "horizon")) db.exec("UPDATE cloud_sync_todo_cursor SET horizon = NULL, full_pull_kind = 'restore'");
    db.prepare("UPDATE cloud_sync_todo_counter SET rewound_at = ?").run(at);
  })();
  return true;
}

// ---------------------------------------------------------------- the sender's reads

export interface SendableRow extends OutboxRow {
  cloud_deal_id: string | null;
  deal_here: string | null;
  /** PR-4b: the todo's cloud id from the shadow (a set / remove addresses it by id), or null. */
  todo_cloud_id?: string | null;
  /** PR-4b: for an item create, its checklist's cloud id from the shadow (the create names its parent by id). */
  checklist_cloud_id?: string | null;
}

/**
 * This user's waiting ops, with the cloud id of their deal. In one transaction: ops of a deal that is gone
 * from this computer and has no online record are dropped (the deal's own removal covers its todos).
 * Another local user's ops are never read.
 */
export function readTodoOutbox(db: SqlDb, projectRef: string, userId: string): { ready: SendableRow[]; waiting: number; dropped: number } {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT o.*, ds.cloud_id AS cloud_deal_id, t.id AS deal_here
           FROM cloud_sync_todo_outbox o
           LEFT JOIN cloud_sync_state ds ON ds.project_ref = o.project_ref AND ds.owner_user_id = o.owner_user_id
                AND ds.entity = 'deal' AND ds.local_id = o.transaction_id
           LEFT JOIN transactions t ON t.id = o.transaction_id
          WHERE o.project_ref = ? AND o.owner_user_id = ?`,
      )
      .all(projectRef, userId) as SendableRow[];
    const ready: SendableRow[] = [];
    let waiting = 0;
    let dropped = 0;
    const del = db.prepare(
      "DELETE FROM cloud_sync_todo_outbox WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ? AND part = ? AND generation = ?",
    );
    // PR-4b (PR-4a review B, "loop"): an op that can never be applied online. A part or removal op of a todo
    // the cloud has no record of (no cloud id in the shadow) and whose create is not waiting either (it was
    // answered with a kept refusal and dropped), and an item create whose checklist is in the same position:
    // the server answers not_found / parent_missing to these on every pass forever. They are dropped with a
    // notice instead. While a full pull is owed such ops wait instead.
    const cloudIds = new Map(
      (db
        .prepare("SELECT entity, local_id, cloud_id FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND cloud_id IS NOT NULL")
        .all(projectRef, userId) as Array<{ entity: string; local_id: string; cloud_id: string }>).map((x) => [`${x.entity}|${x.local_id}`, x.cloud_id] as const),
    );
    const online = new Set(cloudIds.keys());
    const creates = new Set(rows.filter((r) => r.part === "create").map((r) => `${r.entity}|${r.local_id}`));
    const owed = getTodoCursor(db, projectRef, userId)?.full_pull_owed === 1;
    const known = (entity: string, localId: string) => online.has(`${entity}|${localId}`) || creates.has(`${entity}|${localId}`);
    const note = db.prepare(
      `INSERT INTO cloud_sync_todo_notices (project_ref, owner_user_id, entity, local_id, part, kind, transaction_id, other_json, actor_kind, created_at)
       VALUES (?, ?, ?, ?, ?, 'dropped_not_online', ?, ?, 'desktop', ?)`,
    );
    const at = new Date().toISOString();
    for (const r of rows) {
      let checklistOf: string | null = null;
      if (r.part === "create" && r.entity === "item") {
        try {
          const v = JSON.parse(r.value_json ?? "{}") as { checklist_id?: unknown };
          checklistOf = typeof v.checklist_id === "string" ? v.checklist_id : null;
        } catch {
          checklistOf = null;
        }
      }
      const unreachable = r.part === "create" ? checklistOf !== null && !known("checklist", checklistOf) : !known(r.entity, r.local_id);
      if (!r.cloud_deal_id && !r.deal_here) {
        del.run(r.project_ref, r.owner_user_id, r.entity, r.local_id, r.part, r.generation);
        dropped++;
      } else if (unreachable && owed) {
        // Before the full pull the shadow is not filled yet: the op waits for it (after the pull the todo is
        // known, or the scan queues its create).
        waiting++;
      } else if (unreachable) {
        del.run(r.project_ref, r.owner_user_id, r.entity, r.local_id, r.part, r.generation);
        note.run(r.project_ref, r.owner_user_id, r.entity, r.local_id, r.part, r.transaction_id, JSON.stringify({ reason: r.part === "create" ? "checklist_not_online" : "todo_not_online" }), at);
        dropped++;
      } else if (!r.cloud_deal_id) waiting++;
      else {
        // PR-4b (W27): a todo the pull mapped onto a local one of another id has no alias online, so ops name it by
        // its cloud id when the shadow knows it. Not while the todo's (or the parent's) create waits in this
        // outbox: that create names it by local id and (re)establishes the record online.
        r.todo_cloud_id = r.part === "create" || creates.has(`${r.entity}|${r.local_id}`) ? null : cloudIds.get(`${r.entity}|${r.local_id}`) ?? null;
        r.checklist_cloud_id =
          checklistOf !== null && !creates.has(`checklist|${checklistOf}`) ? cloudIds.get(`checklist|${checklistOf}`) ?? null : null;
        ready.push(r);
      }
    }
    return { ready, waiting, dropped };
  })();
}

export function installRemovedAt(db: SqlDb, projectRef: string, userId: string): string | null {
  if (!hasColumn(db, "cloud_sync_settings", "install_removed_at")) return null;
  const r = db.prepare("SELECT install_removed_at FROM cloud_sync_settings WHERE project_ref = ? AND user_id = ?").get(projectRef, userId) as
    | { install_removed_at: string | null }
    | undefined;
  return r?.install_removed_at ?? null;
}

/** install_removed (R8, D2): persisted per user; the outbox is left as it is. */
export function recordInstallRemoved(db: SqlDb, projectRef: string, userId: string, now: Date): void {
  db.prepare("UPDATE cloud_sync_settings SET install_removed_at = ? WHERE project_ref = ? AND user_id = ? AND install_removed_at IS NULL").run(
    now.toISOString(),
    projectRef,
    userId,
  );
}

/** PR-4b (D2): the once-per-launch status check found the copy restored elsewhere: the stop is lifted. */
export function clearInstallRemoved(db: SqlDb, projectRef: string, userId: string): void {
  if (!hasColumn(db, "cloud_sync_settings", "install_removed_at")) return;
  db.prepare("UPDATE cloud_sync_settings SET install_removed_at = NULL WHERE project_ref = ? AND user_id = ?").run(projectRef, userId);
}

// ---------------------------------------------------------------- confirm (R4)

interface AnswerPart {
  rev: number;
  value: JsonValue;
}

function answerParts(answer: Record<string, unknown>): Partial<Record<StatePart, AnswerPart>> {
  const out: Partial<Record<StatePart, AnswerPart>> = {};
  const parts = answer.parts;
  if (!parts || typeof parts !== "object" || Array.isArray(parts)) return out;
  for (const p of STATE_PARTS) {
    const v = (parts as Record<string, unknown>)[p];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const rev = (v as Record<string, unknown>).rev;
    if (typeof rev !== "number" || !Number.isFinite(rev)) continue;
    out[p] = { rev, value: ((v as Record<string, unknown>).value ?? null) as JsonValue };
  }
  return out;
}

function localRow(db: SqlDb, entity: string, localId: string): Record<string, unknown> | null {
  const sql =
    entity === "item"
      ? "SELECT is_checked, checked_at, title, note, due_date, sort_order FROM transaction_checklist_items WHERE id = ?"
      : "SELECT sort_order FROM transaction_checklists WHERE id = ?";
  return (db.prepare(sql).get(localId) as Record<string, unknown> | undefined) ?? null;
}

export interface ConfirmResult {
  deleted: boolean;
  localWrites: TodoPart[];
}

/**
 * One answer, one synchronous transaction, under the apply guard (so writing the winner to the local row
 * records no new op):
 * - confirm: every returned part goes to the shadow unless the shadow already holds a higher rev (a replayed
 *   answer names an older rev: the shadow never moves back). The op's own part(s) — the part of a `set`, every
 *   part of a create — are written to the local row when the server's value differs, its rev is not below
 *   the shadow's, the row was not re-edited during the send, and no other op waits on that part. The outbox
 *   row goes only if its generation is unchanged; otherwise a `rebase` answer moves its base_rev to the
 *   returned rev. A create answer also sets base_rev of the entity's other waiting parts that had none.
 * - final: the outbox row goes (generation unchanged) and a notice records why.
 * - retry / stop: nothing is written.
 */
export function confirmTodoAnswer(
  db: SqlDb,
  row: OutboxRow,
  answer: Record<string, unknown>,
  action: AnswerAction,
  now: Date,
): ConfirmResult {
  const result: ConfirmResult = { deleted: false, localWrites: [] };
  if (action.action === "retry" || action.action === "stop") return result;
  const at = now.toISOString();
  const key = [row.project_ref, row.owner_user_id, row.entity, row.local_id] as const;
  db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO cloud_sync_applying (id, started_at) VALUES (1, ?)").run(at);
    const cur = db
      .prepare("SELECT generation, op_id FROM cloud_sync_todo_outbox WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ? AND part = ?")
      .get(...key, row.part) as { generation: number; op_id: string } | undefined;
    const unchanged = !!cur && cur.generation === row.generation && cur.op_id === row.op_id;
    const deleteRow = () => {
      if (!unchanged) return;
      db.prepare(
        "DELETE FROM cloud_sync_todo_outbox WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ? AND part = ? AND generation = ?",
      ).run(...key, row.part, row.generation);
      result.deleted = true;
    };

    if (action.action === "final") {
      deleteRow();
      db.prepare(
        `INSERT INTO cloud_sync_todo_notices (project_ref, owner_user_id, entity, local_id, part, kind, transaction_id, other_json, actor_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'desktop', ?)`,
      ).run(
        ...key,
        row.part,
        action.notice,
        row.transaction_id,
        JSON.stringify({ status: answer.status ?? null, reason: answer.reason ?? null, field: answer.field ?? null }),
        at,
      );
    } else {
      const parts = answerParts(answer);
      const before =
        (db.prepare("SELECT * FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?").get(...key) as
          | (ShadowRow & Record<string, unknown>)
          | undefined) ?? null;
      // the shadow: one row. PR-4b (SR2 S1): only the part(s) this answer decides locally move — the op's own part
      // (a set), the removed part (a removal), every part (a create, which also writes them all locally). Another
      // part the answer carries (another side changed it) keeps its shadow rev, so the pull applies it locally;
      // moving its shadow here without writing the local row would make the pull skip it and the next scan send
      // the stale local value back. A rev is still never lowered.
      // PR-6 (PC, pr4b-sr-review-2 §1): on a deal locked HERE, a part whose answer would write another side's value
      // into the local row is neither written nor moved in the shadow. The pull then sees that part as newer and
      // takes the lock path (plan §2.4: a locked deal takes no other side's change; this computer's value is sent
      // back held_locked). Parts whose answer equals the local value move as before.
      const lockedHere = (() => {
        if (!row.transaction_id) return false;
        const r = db.prepare(TRANSACTION_SUBMISSION_STATUS_SQL).get(row.transaction_id) as { submission_status: string | null } | undefined;
        return dealLockReason(r?.submission_status) !== null;
      })();
      const localNow = lockedHere ? localRow(db, row.entity, row.local_id) : null;
      const heldBack = (p: StatePart): boolean => {
        if (!lockedHere || !localNow) return false;
        const a = parts[p];
        if (!a || !isPart(row.entity, p)) return false;
        return !samePart(p as TodoPart, partValue(p as TodoPart, localNow), a.value);
      };
      const own = (p: StatePart): boolean =>
        (action.scope === "create" ? true : action.scope === "remove" ? p === "removed" : p === row.part) && !heldBack(p);
      const next: Record<string, unknown> = {
        cloud_id: typeof answer.cloud_id === "string" ? answer.cloud_id : before?.cloud_id ?? null,
        cloud_deal_id: typeof answer.cloud_deal_id === "string" ? answer.cloud_deal_id : before?.cloud_deal_id ?? null,
      };
      for (const p of STATE_PARTS) {
        const a = parts[p];
        const oldRev = before ? (before[`${p}_rev`] as number | null) : null;
        if (a && own(p) && (oldRev === null || oldRev === undefined || a.rev >= oldRev)) {
          next[`${p}_rev`] = a.rev;
          next[`${p}_json`] = JSON.stringify(a.value);
        } else {
          next[`${p}_rev`] = before ? before[`${p}_rev`] ?? null : null;
          next[`${p}_json`] = before ? before[`${p}_json`] ?? null : null;
        }
      }
      const cols = ["cloud_id", "cloud_deal_id", ...STATE_PARTS.flatMap((p) => [`${p}_rev`, `${p}_json`])];
      db.prepare(
        `INSERT INTO cloud_sync_todo_state (project_ref, owner_user_id, entity, local_id, transaction_id, ${cols.join(", ")}, updated_at)
         VALUES (?, ?, ?, ?, ?, ${cols.map(() => "?").join(", ")}, ?)
         ON CONFLICT (project_ref, owner_user_id, entity, local_id) DO UPDATE SET transaction_id = excluded.transaction_id,
           ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`,
      ).run(...key, row.transaction_id, ...cols.map((c) => next[c] as string | number | null), at);

      // the local row: the op's own part(s), when the server's value differs
      const carried: readonly TodoPart[] =
        action.scope === "create" ? partsOfCreate(row.entity) : action.scope === "part" && isPart(row.entity, row.part) ? [row.part] : [];
      const others = new Set(
        (db.prepare("SELECT part FROM cloud_sync_todo_outbox WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?").all(...key) as Array<{
          part: string;
        }>)
          .map((r) => r.part)
          .filter((p) => p !== row.part),
      );
      const local = unchanged && carried.length > 0 ? localRow(db, row.entity, row.local_id) : null;
      for (const p of carried) {
        const a = parts[p];
        const oldRev = before ? (before[`${p}_rev`] as number | null) : null;
        if (!a || !local || others.has(p) || heldBack(p)) continue;
        if (oldRev !== null && oldRev !== undefined && a.rev < oldRev) continue;
        if (samePart(p, partValue(p, local), a.value)) continue;
        const set = partColumns(p, a.value);
        const table = row.entity === "item" ? "transaction_checklist_items" : "transaction_checklists";
        try {
          db.transaction(() => {
            db.prepare(`UPDATE ${table} SET ${Object.keys(set).map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...Object.values(set), row.local_id);
          })();
          result.localWrites.push(p);
        } catch (error) {
          db.prepare(
            `INSERT INTO cloud_sync_todo_notices (project_ref, owner_user_id, entity, local_id, part, kind, transaction_id, other_json, actor_kind, created_at)
             VALUES (?, ?, ?, ?, ?, 'local_write_failed', ?, ?, 'desktop', ?)`,
          ).run(...key, p, row.transaction_id, JSON.stringify({ code: (error as { code?: string })?.code ?? "error" }), at);
        }
      }

      if (unchanged) deleteRow();
      else if (cur && action.rebase && action.scope === "part" && isPart(row.entity, row.part) && parts[row.part]) {
        db.prepare("UPDATE cloud_sync_todo_outbox SET base_rev = ? WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ? AND part = ?").run(
          (parts[row.part] as AnswerPart).rev,
          ...key,
          row.part,
        );
      }
      if (action.scope === "create") {
        const rebase = db.prepare(
          "UPDATE cloud_sync_todo_outbox SET base_rev = ? WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ? AND part = ? AND base_rev IS NULL",
        );
        for (const p of partsOfCreate(row.entity)) {
          const a = parts[p];
          if (a && others.has(p)) rebase.run(a.rev, ...key, p);
        }
      }
    }
    db.exec("DELETE FROM cloud_sync_applying");
  })();
  return result;
}
