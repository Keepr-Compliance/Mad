/**
 * Keepr Cloud todos, the pull's local writes — BACKLOG-4263 PR-4b (plan §3.2 "Pull page", §3.4, §2.4; plan
 * check R3, R4, D7, E4; PR-2 review R1 / DR1 and its PR-4b carry list; PR-4a review C and "For PR-4b").
 *
 * Every function here is synchronous: one page is ONE better-sqlite3 transaction with no `await` inside, so
 * nothing else on the connection can run inside it (a user edit therefore always lands before or after a
 * page, never inside the guarded part, and always records its op). The page's transaction holds:
 *   the apply guard (capture triggers write no op), every row of the page (each in a savepoint), the retry of
 *   parked rows, the counter raise, the cursor pair (next_after, horizon), and on the last page of a pull the
 *   end of a full pull, the re-apply of failed local writes and the post-pull scan. A crash anywhere rolls the
 *   whole page back, so the cursor never moves past a page that was not applied, and a re-delivered page
 *   applies to the same result (see the rules below: nothing is written for a rev the shadow already holds).
 *
 * The rows are cloud_todo_pull's (supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql
 * `cloud_todo_pull`, `_cloud_todo_item_json`, `_cloud_todo_checklist_json`; contract `pull`), observed on the
 * test database by supabase/tests/backlog-4263-pr4b/harness-4b.sql.
 *
 * Rules, per row (item or checklist), for the parts done/title/note/due/order (checklist: order):
 * - A part with an outbox row (or the entity's create still waiting) is never written: the server judges the
 *   waiting op (plan §3.3).
 * - Incremental pull: the shadow and the local row take the pulled value when its rev is above the shadow's
 *   (a rev the shadow holds — this computer's own change coming back — writes nothing and records no op).
 * - Full pull: the shadow takes every pulled value. The local row takes it too, except — outside a restore
 *   pull — a part this computer wrote last (`by` = this install): that local value is this computer's own and
 *   at least as new; the scan after the pull sends the difference against the pulled rev, so it applies
 *   causally. In a restore pull (after a backup restore) the cloud's value always wins.
 * - A locked deal (local submission status) never takes another side's value: the shadow does, and an op
 *   with this computer's value, base_rev = the pulled rev and held_locked, is queued (plan §2.4).
 * - Removed online: the local row is deleted under the guard (its BEFORE DELETE trigger archives it to trash
 *   and writes no op, D7). Restored online (the shadow knew it removed): the local row is created again from
 *   the pulled values and the trash (links whose evidence still exists); a checklist brings back its items.
 * - New online (no shadow, no local row): created locally under the guard with the cloud's local_id.
 * - Purged online: the local row, the shadow and the trash row go.
 * - A row whose deal is not on this computer is skipped. A row that cannot be applied yet (its checklist or
 *   deal unknown, a CHECK failure) is parked and retried after every page.
 * - Deal rows are not applied (deals are one-way; a deal removed online is not removed here).
 * - Conflict events become notices, once per change_seq.
 */
import type { SqlDb } from "./cloudSyncSqlDb";
import type { JsonValue } from "../cloudSync/jcs";
import { TRANSACTION_SUBMISSION_STATUS_SQL } from "./core/transactionEligibilitySql";
import { MY_ITEMS_TEMPLATE_ID } from "./checklistPrivacy";
import { dealLockReason } from "../transactionEligibility";
import {
  currentInstallId,
  getTodoCursor,
  nextEditSeq,
  scanTodos,
  stepTodoEpoch,
} from "./cloudSyncTodoDbService";
import {
  HELD_LOCKED_KEY,
  ITEM_PARTS,
  PART_COLUMNS,
  partColumns,
  partValue,
  samePart,
  type TodoPart,
} from "../cloudSync/todos/wire";

const STATE_PARTS = [
  "done",
  "title",
  "note",
  "due",
  "order",
  "removed",
] as const;
type StatePart = (typeof STATE_PARTS)[number];

export interface PulledPart {
  rev: number;
  value: JsonValue;
  by: string | null;
}

export interface PullPage {
  rows: Array<Record<string, unknown>>;
  next_after: number;
  horizon: number;
  install_max_edit_seq: number | null;
}

export interface PageCounts {
  applied: number;
  unchanged: number;
  skipped: number;
  parked: number;
  unparked: number;
  events: number;
  held: number;
  localWrites: number;
  /** True on the last page of a pull (a short page). */
  complete: boolean;
  /** True when this page finished a full pull. */
  fullPullDone: boolean;
  scanned: number;
  reapplied: number;
}

export interface PullCtx {
  projectRef: string;
  userId: string;
  installId: string;
  now: Date;
}

type Row = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pulledParts(row: Row): Partial<Record<StatePart, PulledPart>> {
  const out: Partial<Record<StatePart, PulledPart>> = {};
  const parts = obj(row.parts);
  if (!parts) return out;
  for (const p of STATE_PARTS) {
    const v = obj(parts[p]);
    const rev = v ? num(v.rev) : null;
    if (!v || rev === null) continue;
    out[p] = { rev, value: (v.value ?? null) as JsonValue, by: str(v.by) };
  }
  return out;
}

function removedValue(v: JsonValue | undefined): boolean {
  const o = obj(v);
  return !!o && o.removed_at !== null && o.removed_at !== undefined;
}

function parseJson(s: unknown): JsonValue | undefined {
  if (typeof s !== "string") return undefined;
  try {
    return JSON.parse(s) as JsonValue;
  } catch {
    return undefined;
  }
}

interface Shadow extends Row {
  local_id: string;
  cloud_id: string | null;
  transaction_id: string | null;
}

/** Is this deal locked on this computer (plan §2.4; the rule is transactionEligibility.dealLockReason). */
export function dealLockedHere(db: SqlDb, transactionId: string): boolean {
  const r = db.prepare(TRANSACTION_SUBMISSION_STATUS_SQL).get(transactionId) as
    { submission_status: string | null } | undefined;
  return dealLockReason(r?.submission_status) !== null;
}

class Page {
  readonly counts: PageCounts = {
    applied: 0,
    unchanged: 0,
    skipped: 0,
    parked: 0,
    unparked: 0,
    events: 0,
    held: 0,
    localWrites: 0,
    complete: false,
    fullPullDone: false,
    scanned: 0,
    reapplied: 0,
  };
  private readonly by: string;
  private readonly at: string;
  /** cloud deal id -> local transaction id, from this page's deal rows */
  private readonly dealRows = new Map<string, string>();

  constructor(
    private readonly db: SqlDb,
    private readonly ctx: PullCtx,
    private readonly full: boolean,
    private readonly restore: boolean,
  ) {
    this.by = `desktop:${ctx.installId}`;
    this.at = ctx.now.toISOString();
  }

  noteDealRow(row: Row): void {
    const cid = str(row.cloud_id);
    const lid = str(row.local_id);
    if (cid && lid) this.dealRows.set(cid, lid);
  }

  // ------------------------------------------------------------ lookups

  private shadowByCloud(entity: string, cloudId: string): Shadow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND cloud_id = ?",
        )
        .get(this.ctx.projectRef, this.ctx.userId, entity, cloudId) as
        Shadow | undefined) ?? null
    );
  }

  private shadowByLocal(entity: string, localId: string): Shadow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?",
        )
        .get(this.ctx.projectRef, this.ctx.userId, entity, localId) as
        Shadow | undefined) ?? null
    );
  }

  private pending(entity: string, localId: string): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            "SELECT part FROM cloud_sync_todo_outbox WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?",
          )
          .all(this.ctx.projectRef, this.ctx.userId, entity, localId) as Array<{
          part: string;
        }>
      ).map((r) => r.part),
    );
  }

  private localItem(id: string): Row | null {
    return (
      (this.db
        .prepare(
          `SELECT i.*, c.transaction_id AS tx FROM transaction_checklist_items i JOIN transaction_checklists c ON c.id = i.checklist_id WHERE i.id = ?`,
        )
        .get(id) as Row | undefined) ?? null
    );
  }

  private localChecklist(id: string): Row | null {
    return (
      (this.db
        .prepare(
          "SELECT *, transaction_id AS tx FROM transaction_checklists WHERE id = ?",
        )
        .get(id) as Row | undefined) ?? null
    );
  }

  /** The local transaction of a cloud deal id: the deal's sync record, else this page's deal row. */
  private dealOf(cloudDealId: string | null): string | null {
    if (!cloudDealId) return null;
    const r = this.db
      .prepare(
        "SELECT local_id FROM cloud_sync_state WHERE project_ref = ? AND owner_user_id = ? AND entity = 'deal' AND cloud_id = ?",
      )
      .get(this.ctx.projectRef, this.ctx.userId, cloudDealId) as
      { local_id: string } | undefined;
    return r?.local_id ?? this.dealRows.get(cloudDealId) ?? null;
  }

  private dealHere(tx: string): boolean {
    const r = this.db
      .prepare("SELECT user_id FROM transactions WHERE id = ?")
      .get(tx) as { user_id: string } | undefined;
    return !!r && r.user_id === this.ctx.userId;
  }

  // ------------------------------------------------------------ writes

  private writeShadow(
    entity: string,
    localId: string,
    tx: string,
    cloudId: string,
    cloudDealId: string | null,
    parts: Partial<Record<StatePart, PulledPart>>,
    skip: Set<string>,
  ): void {
    const before = this.shadowByLocal(entity, localId);
    const next: Record<string, unknown> = {
      cloud_id: cloudId,
      cloud_deal_id: cloudDealId ?? before?.cloud_deal_id ?? null,
    };
    for (const p of STATE_PARTS) {
      const a = parts[p];
      const oldRev = before ? num(before[`${p}_rev`]) : null;
      const take =
        !!a && !skip.has(p) && (this.full || oldRev === null || a.rev > oldRev);
      next[`${p}_rev`] = take
        ? a!.rev
        : before
          ? (before[`${p}_rev`] ?? null)
          : null;
      next[`${p}_json`] = take
        ? JSON.stringify(a!.value)
        : before
          ? (before[`${p}_json`] ?? null)
          : null;
    }
    const cols = [
      "cloud_id",
      "cloud_deal_id",
      ...STATE_PARTS.flatMap((p) => [`${p}_rev`, `${p}_json`]),
    ];
    this.db
      .prepare(
        `INSERT INTO cloud_sync_todo_state (project_ref, owner_user_id, entity, local_id, transaction_id, ${cols.join(", ")}, updated_at)
         VALUES (?, ?, ?, ?, ?, ${cols.map(() => "?").join(", ")}, ?)
         ON CONFLICT (project_ref, owner_user_id, entity, local_id) DO UPDATE SET transaction_id = excluded.transaction_id,
           ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = excluded.updated_at`,
      )
      .run(
        this.ctx.projectRef,
        this.ctx.userId,
        entity,
        localId,
        tx,
        ...cols.map((c) => next[c] as string | number | null),
        this.at,
      );
  }

  private writeLocal(
    entity: string,
    localId: string,
    part: TodoPart,
    value: JsonValue,
  ): void {
    const set = partColumns(part, value);
    const table =
      entity === "item"
        ? "transaction_checklist_items"
        : "transaction_checklists";
    this.db
      .prepare(
        `UPDATE ${table} SET ${Object.keys(set)
          .map((c) => `${c} = ?`)
          .join(", ")} WHERE id = ?`,
      )
      .run(...Object.values(set), localId);
    this.counts.localWrites++;
  }

  /** plan §2.4: keep this computer's value on a locked deal; the op wins causally against the pulled rev. */
  private queueHeld(
    entity: string,
    localId: string,
    tx: string,
    part: TodoPart,
    local: Row,
    rev: number,
  ): void {
    const cols: Record<string, unknown> = {};
    for (const c of PART_COLUMNS[part]) cols[c] = local[c] ?? null;
    cols[HELD_LOCKED_KEY] = true;
    // the counter steps and the op insert commit together (a savepoint inside the page's transaction)
    this.db.transaction(() => {
      const epoch = stepTodoEpoch(this.db, this.ctx.projectRef, this.ctx.now);
      this.db
        .prepare(
          `INSERT INTO cloud_sync_todo_outbox
           (project_ref, owner_user_id, entity, local_id, part, transaction_id, value_json, base_rev, edit_seq, edited_at, clock_epoch, op_id, generation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, lower(hex(randomblob(16))), 1)
         ON CONFLICT (project_ref, owner_user_id, entity, local_id, part) DO NOTHING`,
        )
        .run(
          this.ctx.projectRef,
          this.ctx.userId,
          entity,
          localId,
          part,
          tx,
          JSON.stringify(cols),
          rev,
          nextEditSeq(this.db, this.ctx.projectRef),
          this.at,
          epoch,
        );
    })();
    this.counts.held++;
  }

  private park(row: Row, code: string): void {
    const entity = str(row.entity) ?? "unknown";
    const cloudId = str(row.cloud_id) ?? "unknown";
    const seq = num(row.change_seq);
    this.db
      .prepare(
        `INSERT INTO cloud_sync_todo_parked (project_ref, owner_user_id, entity, cloud_id, change_seq, row_json, error_code, attempts, parked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (project_ref, owner_user_id, entity, cloud_id) DO UPDATE SET
           change_seq = CASE WHEN excluded.change_seq >= coalesce(cloud_sync_todo_parked.change_seq, -1) THEN excluded.change_seq ELSE cloud_sync_todo_parked.change_seq END,
           row_json = CASE WHEN excluded.change_seq >= coalesce(cloud_sync_todo_parked.change_seq, -1) THEN excluded.row_json ELSE cloud_sync_todo_parked.row_json END,
           error_code = excluded.error_code, attempts = cloud_sync_todo_parked.attempts + 1`,
      )
      .run(
        this.ctx.projectRef,
        this.ctx.userId,
        entity,
        cloudId,
        seq,
        JSON.stringify(row),
        code.slice(0, 64),
        this.at,
      );
    this.counts.parked++;
  }

  private unpark(entity: string, cloudId: string, seq: number | null): void {
    const r = this.db
      .prepare(
        "DELETE FROM cloud_sync_todo_parked WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND cloud_id = ? AND coalesce(change_seq, -1) <= ?",
      )
      .run(
        this.ctx.projectRef,
        this.ctx.userId,
        entity,
        cloudId,
        seq ?? Number.MAX_SAFE_INTEGER,
      );
    this.counts.unparked += Number(
      (r as { changes?: number } | undefined)?.changes ?? 0,
    );
  }

  // ------------------------------------------------------------ one row

  /** Applies one row inside a savepoint; a failure rolls back that row alone and parks it. */
  applyRow(row: Row, fromParked = false): void {
    const entity = str(row.entity);
    if (entity === "deal") {
      this.noteDealRow(row);
      this.counts.skipped++;
      return;
    }
    if (entity === "event") {
      this.applyEvent(row);
      return;
    }
    if (entity !== "item" && entity !== "checklist") {
      this.counts.skipped++;
      return;
    }
    try {
      const outcome = this.applyTodo(entity, row);
      if (outcome === "park_parent") throw new ParkError("parent_not_here");
      if (outcome === "park_deal") throw new ParkError("deal_unknown");
      this.unpark(entity, str(row.cloud_id) ?? "", num(row.change_seq));
    } catch (error) {
      const code =
        error instanceof ParkError
          ? error.code
          : ((error as { code?: string })?.code ?? "apply_failed");
      if (fromParked) {
        this.db
          .prepare(
            "UPDATE cloud_sync_todo_parked SET attempts = attempts + 1, error_code = ? WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND cloud_id = ?",
          )
          .run(
            String(code).slice(0, 64),
            this.ctx.projectRef,
            this.ctx.userId,
            entity,
            str(row.cloud_id) ?? "",
          );
      } else this.park(row, String(code));
    }
  }

  private applyEvent(row: Row): void {
    const seq = num(row.change_seq);
    if (seq === null) return;
    const dup = this.db
      .prepare(
        "SELECT 1 FROM cloud_sync_todo_notices WHERE project_ref = ? AND owner_user_id = ? AND kind = 'conflict' AND change_seq = ?",
      )
      .get(this.ctx.projectRef, this.ctx.userId, seq);
    if (dup) return;
    const about = str(row.about) ?? "item";
    const cid = str(row.cloud_id);
    const sh = cid ? this.shadowByCloud(about, cid) : null;
    const by = str(row.by) ?? "";
    const other = {
      about,
      cloud_id: cid,
      part: row.part ?? null,
      outcome: row.outcome ?? null,
      loser_value: row.loser_value ?? null,
      winner_value: row.winner_value ?? null,
      by,
      other_by: row.other_by ?? null,
      effective_at: row.effective_at ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO cloud_sync_todo_notices (project_ref, owner_user_id, entity, local_id, part, kind, transaction_id, other_json, actor_kind, actor_label, change_seq, created_at)
         VALUES (?, ?, ?, ?, ?, 'conflict', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ctx.projectRef,
        this.ctx.userId,
        about,
        sh?.local_id ?? cid ?? "",
        str(row.part),
        sh?.transaction_id ?? this.dealOf(str(row.cloud_deal_id)),
        JSON.stringify(other),
        by.split(":")[0] || null,
        str(row.label),
        seq,
        this.at,
      );
    this.counts.events++;
  }

  /** One todo row, in its own savepoint (a failure rolls back this row alone; the caller parks it). */
  private applyTodo(
    entity: "item" | "checklist",
    row: Row,
  ): "ok" | "park_parent" | "park_deal" {
    return this.db.transaction((): "ok" | "park_parent" | "park_deal" => {
      const cloudId = str(row.cloud_id);
      if (!cloudId) return "ok";
      const byCloud = this.shadowByCloud(entity, cloudId);
      const localId = byCloud?.local_id ?? str(row.local_id) ?? cloudId;
      const shadow = byCloud ?? this.shadowByLocal(entity, localId);
      const local =
        entity === "item"
          ? this.localItem(localId)
          : this.localChecklist(localId);
      let tx: string | null = local
        ? (str(local.tx) as string)
        : (this.dealOf(str(row.cloud_deal_id)) ??
          shadow?.transaction_id ??
          null);
      if (!tx) {
        // The deal is not known here at all: it may be uploaded later in a pass; parked and retried.
        if (!shadow) return "park_deal";
        tx = shadow.transaction_id;
      }
      if (!tx || !this.dealHere(tx)) {
        this.counts.skipped++;
        return "ok";
      }

      if (row.purged === true) {
        if (local) this.deleteLocal(entity, localId);
        this.db
          .prepare(
            "DELETE FROM cloud_sync_todo_state WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?",
          )
          .run(this.ctx.projectRef, this.ctx.userId, entity, localId);
        this.db
          .prepare(
            "DELETE FROM cloud_sync_todo_trash WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?",
          )
          .run(this.ctx.projectRef, this.ctx.userId, entity, localId);
        if (entity === "checklist") {
          this.db
            .prepare(
              "DELETE FROM cloud_sync_todo_trash WHERE project_ref = ? AND owner_user_id = ? AND removed_with = ?",
            )
            .run(this.ctx.projectRef, this.ctx.userId, localId);
        }
        this.counts.applied++;
        return "ok";
      }

      const parts = pulledParts(row);
      const pending = this.pending(entity, localId);
      const createWaiting = pending.has("create");
      const skip = new Set<string>([...pending].filter((p) => p !== "create"));
      if (createWaiting) for (const p of STATE_PARTS) skip.add(p);
      const removedOnline = removedValue(parts.removed?.value);
      const shadowSaysRemoved =
        !!shadow && removedValue(parseJson(shadow.removed_json));
      const cloudDealId = str(row.cloud_deal_id);

      if (removedOnline) {
        this.writeShadow(
          entity,
          localId,
          tx,
          cloudId,
          cloudDealId,
          parts,
          skip,
        );
        if (local && !pending.has("removed")) this.deleteLocal(entity, localId);
        this.counts.applied++;
        return "ok";
      }

      if (!local) {
        if (pending.has("removed")) {
          // Deleted here, the removal not sent yet: the server decides; the local row is not brought back.
          this.writeShadow(
            entity,
            localId,
            tx,
            cloudId,
            cloudDealId,
            parts,
            skip,
          );
          this.counts.applied++;
          return "ok";
        }
        if (shadow && !shadowSaysRemoved) {
          // Gone locally with its checklist or deal (no op of its own): only the shadow moves.
          this.writeShadow(
            entity,
            localId,
            tx,
            cloudId,
            cloudDealId,
            parts,
            skip,
          );
          this.counts.applied++;
          return "ok";
        }
        // Restored online (the shadow knew it removed), or new from another side (no shadow): create it here.
        const made =
          entity === "item"
            ? this.createItem(localId, row, parts, cloudId, tx)
            : this.createChecklist(localId, row, parts, cloudId, tx);
        if (made === "park_parent") return "park_parent";
        this.counts.applied++;
        return "ok";
      }

      // The local row exists: per part.
      const locked = dealLockedHere(this.db, tx);
      const names: readonly TodoPart[] =
        entity === "item" ? ITEM_PARTS : (["order"] as const);
      const writes: Array<{ part: TodoPart; value: JsonValue }> = [];
      let changed = false;
      for (const p of names) {
        const a = parts[p];
        if (!a || skip.has(p)) continue;
        const oldRev = shadow ? num(shadow[`${p}_rev`]) : null;
        const newer = oldRev === null || a.rev > oldRev;
        if (!this.full && !newer) continue;
        changed = changed || newer;
        if (samePart(p, partValue(p, local), a.value)) continue;
        if (this.full && !this.restore && a.by === this.by) continue; // this computer's own value stays; the scan sends it
        if (locked && a.by !== this.by) {
          this.queueHeld(entity, localId, tx, p, local, a.rev);
          continue;
        }
        writes.push({ part: p, value: a.value });
      }
      this.writeShadow(entity, localId, tx, cloudId, cloudDealId, parts, skip);
      for (const w of writes) this.writeLocal(entity, localId, w.part, w.value);
      if (changed || writes.length > 0) this.counts.applied++;
      else this.counts.unchanged++;
      return "ok";
    })();
  }

  private deleteLocal(entity: string, localId: string): void {
    const table =
      entity === "item"
        ? "transaction_checklist_items"
        : "transaction_checklists";
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(localId);
  }

  private trash(entity: string, localId: string): Row | null {
    const r = this.db
      .prepare(
        "SELECT payload_json FROM cloud_sync_todo_trash WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?",
      )
      .get(this.ctx.projectRef, this.ctx.userId, entity, localId) as
      { payload_json: string | null } | undefined;
    return r ? (obj(parseJson(r.payload_json)) ?? {}) : null;
  }

  private dropTrash(entity: string, localId: string): void {
    this.db
      .prepare(
        "DELETE FROM cloud_sync_todo_trash WHERE project_ref = ? AND owner_user_id = ? AND entity = ? AND local_id = ?",
      )
      .run(this.ctx.projectRef, this.ctx.userId, entity, localId);
  }

  /** The local checklist an item's cloud checklist id maps to (its shadow), or null. */
  private localChecklistOf(cloudChecklistId: string | null): string | null {
    if (!cloudChecklistId) return null;
    const sh = this.shadowByCloud("checklist", cloudChecklistId);
    if (sh && this.localChecklist(sh.local_id)) return sh.local_id;
    return null;
  }

  private createItem(
    localId: string,
    row: Row,
    parts: Partial<Record<StatePart, PulledPart>>,
    cloudId: string,
    tx: string,
  ): "ok" | "park_parent" {
    const checklist = this.localChecklistOf(str(row.cloud_checklist_id));
    if (!checklist) return "park_parent";
    const trash = this.trash("item", localId);
    const old = obj(trash?.item) ?? {};
    this.insertItem(localId, checklist, row, parts, old);
    this.restoreLinks(localId, trash);
    this.dropTrash("item", localId);
    this.writeShadow(
      "item",
      localId,
      tx,
      cloudId,
      str(row.cloud_deal_id),
      parts,
      new Set(),
    );
    return "ok";
  }

  private insertItem(
    localId: string,
    checklist: string,
    row: Row,
    parts: Partial<Record<StatePart, PulledPart>>,
    old: Row,
  ): void {
    const v = (p: TodoPart): Record<string, string | number | null> =>
      parts[p]
        ? partColumns(p, parts[p]!.value)
        : partColumns(p, partValue(p, old));
    const done = v("done");
    this.db
      .prepare(
        `INSERT INTO transaction_checklist_items (id, checklist_id, title, description, is_required, expected_document_type, is_checked, checked_at, note, due_date, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, CURRENT_TIMESTAMP))`,
      )
      .run(
        localId,
        checklist,
        v("title").title,
        str(row.description) ?? str(old.description),
        row.is_required === true || old.is_required === 1 ? 1 : 0,
        str(row.expected_document_type) ?? str(old.expected_document_type),
        done.is_checked,
        done.checked_at,
        v("note").note,
        v("due").due_date,
        v("order").sort_order ?? 0,
        str(old.created_at) ?? str(row.local_created_at) ?? null,
      );
    this.counts.localWrites++;
  }

  /** Links and members from the trash, where the evidence they point to still exists (plan W35). */
  private restoreLinks(itemId: string, trash: Row | null): void {
    const links = Array.isArray(trash?.links)
      ? (trash!.links as unknown[])
      : [];
    for (const l of links) {
      const link = obj(l);
      if (!link || typeof link.id !== "string") continue;
      try {
        this.db.transaction(() => {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO transaction_checklist_links (id, item_id, kind, label, sort_order, created_at, include_outside_dates)
               VALUES (?, ?, ?, ?, ?, coalesce(?, CURRENT_TIMESTAMP), ?)`,
            )
            .run(
              link.id,
              itemId,
              link.kind as string,
              link.label as string,
              num(link.sort_order) ?? 0,
              str(link.created_at),
              num(link.include_outside_dates) ?? 0,
            );
          for (const m of Array.isArray(link.members)
            ? (link.members as unknown[])
            : []) {
            const mem = obj(m);
            if (!mem || typeof mem.id !== "string") continue;
            const exists =
              mem.kind === "attachment"
                ? this.db
                    .prepare("SELECT 1 FROM attachments WHERE id = ?")
                    .get(mem.attachment_id)
                : mem.kind === "email"
                  ? this.db
                      .prepare("SELECT 1 FROM emails WHERE id = ?")
                      .get(mem.email_id)
                  : mem.kind === "text"
                    ? this.db
                        .prepare("SELECT 1 FROM messages WHERE id = ?")
                        .get(mem.message_id)
                    : undefined;
            if (!exists) continue;
            this.db
              .prepare(
                "INSERT OR IGNORE INTO transaction_checklist_link_members (id, link_id, kind, attachment_id, email_id, message_id) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                mem.id,
                link.id,
                mem.kind as string,
                str(mem.attachment_id),
                str(mem.email_id),
                str(mem.message_id),
              );
          }
        })();
      } catch {
        /* that link stays out; the item is restored */
      }
    }
  }

  private createChecklist(
    localId: string,
    row: Row,
    parts: Partial<Record<StatePart, PulledPart>>,
    cloudId: string,
    tx: string,
  ): "ok" | "park_parent" {
    const templateId = str(row.template_id) ?? "";
    // W27: a checklist of the same template already on this deal (UNIQUE (transaction_id, template_id)): the
    // pulled one maps to it when that one has no other online record.
    const same = this.db
      .prepare(
        "SELECT id FROM transaction_checklists WHERE transaction_id = ? AND template_id = ?",
      )
      .get(tx, templateId) as { id: string } | undefined;
    if (same) {
      const sh = this.shadowByLocal("checklist", same.id);
      if (sh?.cloud_id && sh.cloud_id !== cloudId) {
        this.counts.skipped++;
        return "ok";
      }
      this.writeShadow(
        "checklist",
        same.id,
        tx,
        cloudId,
        str(row.cloud_deal_id),
        parts,
        this.pending("checklist", same.id),
      );
      return "ok";
    }
    const trash = this.trash("checklist", localId);
    const old = obj(trash?.checklist) ?? {};
    const name =
      str(row.template_name) ??
      str(old.template_name) ??
      (templateId === MY_ITEMS_TEMPLATE_ID ? "My items" : null);
    if (!name) throw new ParkError("no_name");
    const order = parts.order
      ? partColumns("order", parts.order.value).sort_order
      : num(old.sort_order);
    this.db
      .prepare(
        "INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order, selected_at) VALUES (?, ?, ?, ?, ?, coalesce(?, CURRENT_TIMESTAMP))",
      )
      .run(localId, tx, templateId, name, order ?? 0, str(old.selected_at));
    this.counts.localWrites++;
    this.dropTrash("checklist", localId);
    this.writeShadow(
      "checklist",
      localId,
      tx,
      cloudId,
      str(row.cloud_deal_id),
      parts,
      new Set(),
    );
    // A restored checklist brings back the items removed with it (their own online rows keep their numbers,
    // so they are not in this pull): from their shadow (the cloud's last values) and the trash.
    const items = this.db
      .prepare(
        "SELECT local_id, payload_json FROM cloud_sync_todo_trash WHERE project_ref = ? AND owner_user_id = ? AND entity = 'item' AND removed_with = ?",
      )
      .all(this.ctx.projectRef, this.ctx.userId, localId) as Array<{
      local_id: string;
      payload_json: string | null;
    }>;
    for (const it of items) {
      const payload = obj(parseJson(it.payload_json)) ?? {};
      const sh = this.shadowByLocal("item", it.local_id);
      if (sh && removedValue(parseJson(sh.removed_json))) continue; // removed on its own online: stays removed
      const shParts: Partial<Record<StatePart, PulledPart>> = {};
      for (const p of ITEM_PARTS) {
        const v = sh ? parseJson(sh[`${p}_json`]) : undefined;
        if (sh && v !== undefined && num(sh[`${p}_rev`]) !== null)
          shParts[p] = {
            rev: num(sh[`${p}_rev`]) as number,
            value: v,
            by: null,
          };
      }
      try {
        this.db.transaction(() => {
          this.insertItem(
            it.local_id,
            localId,
            {},
            shParts,
            obj(payload.item) ?? {},
          );
          this.restoreLinks(it.local_id, payload);
          this.dropTrash("item", it.local_id);
        })();
      } catch {
        /* that item stays in the trash */
      }
    }
    return "ok";
  }

  // ------------------------------------------------------------ parked rows, failed writes

  retryParked(): void {
    const rows = this.db
      .prepare(
        "SELECT row_json FROM cloud_sync_todo_parked WHERE project_ref = ? AND owner_user_id = ? ORDER BY coalesce(change_seq, 0)",
      )
      .all(this.ctx.projectRef, this.ctx.userId) as Array<{
      row_json: string | null;
    }>;
    for (const r of rows) {
      const row = obj(parseJson(r.row_json));
      if (row) this.applyRow(row, true);
    }
  }

  /**
   * A confirm whose local write-back failed (PR-4a: notice `local_write_failed`) left the shadow on the
   * server's value and the local row on the old one. Re-applied here from the shadow, before any scan (else
   * the scan would send the old value against the matching base and overwrite the winner).
   */
  reapplyFailedWrites(): void {
    const rows = this.db
      .prepare(
        "SELECT id, entity, local_id, part FROM cloud_sync_todo_notices WHERE project_ref = ? AND owner_user_id = ? AND kind = 'local_write_failed' AND dismissed_at IS NULL",
      )
      .all(this.ctx.projectRef, this.ctx.userId) as Array<{
      id: number;
      entity: string;
      local_id: string;
      part: string;
    }>;
    const dismiss = this.db.prepare(
      "UPDATE cloud_sync_todo_notices SET dismissed_at = ? WHERE id = ?",
    );
    for (const n of rows) {
      const part = n.part as TodoPart;
      if (!(ITEM_PARTS as readonly string[]).includes(part)) {
        dismiss.run(this.at, n.id);
        continue;
      }
      const pend = this.pending(n.entity, n.local_id);
      if (pend.has(part) || pend.has("create")) continue;
      const sh = this.shadowByLocal(n.entity, n.local_id);
      const local =
        n.entity === "item"
          ? this.localItem(n.local_id)
          : this.localChecklist(n.local_id);
      const v = sh ? parseJson(sh[`${part}_json`]) : undefined;
      if (!sh || !local || v === undefined) {
        dismiss.run(this.at, n.id);
        continue;
      }
      try {
        this.db.transaction(() => {
          if (!samePart(part, partValue(part, local), v))
            this.writeLocal(n.entity, n.local_id, part, v);
          dismiss.run(this.at, n.id);
        })();
        this.counts.reapplied++;
      } catch {
        /* stays; tried again after the next pull */
      }
    }
  }
}

class ParkError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Applies one pull page (see the header), and stores (next_after, horizon) with it, in ONE transaction.
 * `limit` is the page size asked for: a page with fewer rows is the last page of this pull.
 */
export function applyTodoPage(
  db: SqlDb,
  ctx: PullCtx,
  page: PullPage,
  limit: number,
): PageCounts {
  return db.transaction(() => {
    const cur = getTodoCursor(db, ctx.projectRef, ctx.userId);
    const full = cur?.full_pull_owed === 1;
    const restore = full && cur?.full_pull_kind === "restore";
    db.prepare(
      "INSERT OR REPLACE INTO cloud_sync_applying (id, started_at) VALUES (1, ?)",
    ).run(ctx.now.toISOString());
    const p = new Page(db, ctx, full, restore);
    for (const r of page.rows) if (str(r.entity) === "deal") p.noteDealRow(r);
    for (const r of page.rows) p.applyRow(r);
    p.retryParked();
    // R3: a restored backup rewinds the counter; it is raised from what the cloud holds for this install.
    const install = currentInstallId(db, ctx.projectRef);
    if (install && page.install_max_edit_seq !== null) {
      db.prepare(
        "UPDATE cloud_sync_todo_counter SET edit_seq = max(edit_seq, ?) WHERE project_ref = ? AND install_id = ?",
      ).run(page.install_max_edit_seq, ctx.projectRef, install);
    }
    db.prepare(
      "UPDATE cloud_sync_todo_cursor SET last_seq = ?, horizon = ?, updated_at = ? WHERE project_ref = ? AND owner_user_id = ?",
    ).run(
      page.next_after,
      page.horizon,
      ctx.now.toISOString(),
      ctx.projectRef,
      ctx.userId,
    );
    const counts = p.counts;
    counts.complete = page.rows.length < limit;
    if (counts.complete) {
      if (full) {
        db.prepare(
          "UPDATE cloud_sync_todo_cursor SET full_pull_owed = 0, full_pull_kind = NULL WHERE project_ref = ? AND owner_user_id = ?",
        ).run(ctx.projectRef, ctx.userId);
        counts.fullPullDone = true;
        // The counter stays marked rewound until every user's restore pull is done (it is per install).
        const owedRestore = db
          .prepare(
            "SELECT 1 FROM cloud_sync_todo_cursor WHERE project_ref = ? AND full_pull_owed = 1 AND full_pull_kind = 'restore' LIMIT 1",
          )
          .get(ctx.projectRef);
        if (!owedRestore)
          db.prepare(
            "UPDATE cloud_sync_todo_counter SET rewound_at = NULL WHERE project_ref = ?",
          ).run(ctx.projectRef);
      }
      p.reapplyFailedWrites();
    }
    db.exec("DELETE FROM cloud_sync_applying");
    // The scan after a full pull (plan §2.2, §3.4; PR-4a review C order), in this same transaction, after the
    // guard is gone (the scan writes its ops itself; the guard only matters to the capture triggers).
    if (counts.fullPullDone)
      counts.scanned = scanTodos(db, ctx.projectRef, ctx.userId, ctx.now);
    return counts;
  })();
}

/** resync_required / horizon_required: nothing of that answer is applied; the cursor owes a full pull from 0. */
export function resetTodoCursorForFullPull(
  db: SqlDb,
  projectRef: string,
  userId: string,
  now: Date,
): void {
  db.prepare(
    "UPDATE cloud_sync_todo_cursor SET last_seq = 0, horizon = NULL, full_pull_owed = 1, updated_at = ? WHERE project_ref = ? AND owner_user_id = ?",
  ).run(now.toISOString(), projectRef, userId);
}
