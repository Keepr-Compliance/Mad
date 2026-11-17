/**
 * Keepr Cloud todos: local values <-> the wire — BACKLOG-4263 PR-4a.
 *
 * The server contract is supabase/contracts/cloud-todo-change-v1.json (`op_fields`, `field_types`) and
 * `_cloud_todo_apply_op` / `_cloud_todo_norm` in
 * supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql. A field present with a JSON type
 * outside its list rejects the op (`rejected` / `invalid_value`), so every value read from SQLite is
 * converted here: 0/1 to JSON booleans, the capture triggers' one-key part objects (`{"title": …}`) to the
 * bare wire value of that part, timestamps to ISO-8601 UTC, sort orders to integers.
 *
 * Nothing here does I/O.
 */
import type { JsonValue } from "../jcs";
import { instant } from "../projection";
import { isPrivateChecklist } from "../../db/checklistPrivacy";

export const ITEM_PARTS = ["done", "title", "note", "due", "order"] as const;
export const CHECKLIST_PARTS = ["order"] as const;
export type TodoPart = (typeof ITEM_PARTS)[number];
export type TodoEntity = "item" | "checklist";

/** Columns of the local row each part is made of (same list as TODO_ITEM_PARTS in cloudSyncTodoSql.ts). */
export const PART_COLUMNS: Record<TodoPart, readonly string[]> = {
  done: ["is_checked", "checked_at"],
  title: ["title"],
  note: ["note"],
  due: ["due_date"],
  order: ["sort_order"],
};

/** One outbox row as PR-3's triggers (and the scan) write it. */
export interface OutboxRow {
  project_ref: string;
  owner_user_id: string;
  entity: string;
  local_id: string;
  part: string;
  transaction_id: string | null;
  value_json: string | null;
  base_rev: number | null;
  edit_seq: number | null;
  edited_at: string;
  clock_epoch: number | null;
  op_id: string;
  generation: number;
}

/** An op as cloud_todo_push takes it (contract `op_fields`). */
export type WireOp = { [key: string]: JsonValue };

export function toBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number" || typeof v === "bigint") return Number(v) !== 0;
  if (typeof v === "string") {
    if (v === "1" || v.toLowerCase() === "true") return true;
    if (v === "0" || v.toLowerCase() === "false") return false;
  }
  return null;
}

function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : String(v);
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** The wire value of one part from the local columns (a row, or a trigger's one-key object). */
export function partValue(part: TodoPart, cols: Record<string, unknown>): JsonValue {
  switch (part) {
    case "done": {
      const checked = toBool(cols.is_checked) === true;
      return { is_checked: checked, checked_at: checked ? instant(cols.checked_at) : null };
    }
    case "title":
      return toText(cols.title) ?? "";
    case "note":
      return toText(cols.note);
    case "due":
      return toText(cols.due_date);
    case "order":
      return toInt(cols.sort_order);
  }
}

/** The local column values of one part from its wire value (the confirm's write-back). */
export function partColumns(part: TodoPart, value: JsonValue): Record<string, string | number | null> {
  switch (part) {
    case "done": {
      const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, JsonValue>;
      const checked = toBool(v.is_checked) === true;
      return { is_checked: checked ? 1 : 0, checked_at: checked ? instant(v.checked_at) ?? new Date().toISOString() : null };
    }
    case "title":
      return { title: toText(value) ?? "" };
    case "note":
      return { note: toText(value) };
    case "due":
      return { due_date: toText(value) };
    case "order":
      return { sort_order: toInt(value) };
  }
}

/**
 * Equal values (the server's `_cloud_todo_same`, migration :365-369): `done` compares is_checked only;
 * every other part compares the whole value.
 */
export function samePart(part: TodoPart, a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (part === "done") {
    const ca = a && typeof a === "object" && !Array.isArray(a) ? toBool((a as Record<string, JsonValue>).is_checked) === true : toBool(a) === true;
    const cb = b && typeof b === "object" && !Array.isArray(b) ? toBool((b as Record<string, JsonValue>).is_checked) === true : toBool(b) === true;
    return ca === cb;
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The 32-hex op_id the triggers mint, as the uuid text the server echoes (8-4-4-4-12, lower case). */
export function wireOpId(opId: string): string {
  const h = normOpId(opId);
  return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : opId;
}

/** Matching key for an op_id in either form. */
export function normOpId(opId: unknown): string {
  return typeof opId === "string" ? opId.replace(/-/g, "").toLowerCase() : "";
}

/**
 * The scan's ops carry this epoch: their edit time is not known (the scan only sees that local differs
 * from the shadow), so they are sent as `clock_stepped` (unknowable, contract `effective_time`): they lose
 * every concurrent conflict and apply only on a matching base or a later edit of this same install.
 */
export const SCAN_EPOCH = -1;

/**
 * PR-4b: the marker the puller writes into an outbox row's value_json when it keeps this computer's value on a
 * locked deal instead of applying another side's change (plan §2.4 `held_locked`). A user edit of that part
 * replaces value_json (capture trigger), which drops the marker.
 */
export const HELD_LOCKED_KEY = "_held_locked";

export interface EncodeContext {
  cloudDealId: string;
  /** PR-4b (W27): the todo's cloud id (a set / remove names it by id; the server then ignores local_id). */
  todoCloudId?: string | null;
  /** PR-4b (W27): an item create's checklist cloud id (the server finds the parent by it). */
  checklistCloudId?: string | null;
  /** The counter's epoch now; an op from an earlier epoch is sent with clock_stepped = true (E2). */
  currentEpoch: number;
}

function parseValue(row: OutboxRow): Record<string, unknown> {
  if (!row.value_json) return {};
  try {
    const v = JSON.parse(row.value_json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function isPart(entity: string, part: string): part is TodoPart {
  return entity === "item" ? (ITEM_PARTS as readonly string[]).includes(part) : entity === "checklist" ? part === "order" : false;
}

/** E2: an op recorded in an earlier clock epoch (or by the scan) has an unknowable time. */
export function clockStepped(row: Pick<OutboxRow, "clock_epoch">, currentEpoch: number): boolean {
  return row.clock_epoch !== null && row.clock_epoch !== undefined && row.clock_epoch < currentEpoch;
}

/** One outbox row as one wire op, or null when the row is not a kind this build sends. */
export function encodeOp(row: OutboxRow, ctx: EncodeContext): WireOp | null {
  const base: WireOp = {
    op_id: wireOpId(row.op_id),
    edited_at: row.edited_at,
    clock_stepped: clockStepped(row, ctx.currentEpoch),
  };
  const v = parseValue(row);
  const editSeq = row.edit_seq === null || row.edit_seq === undefined ? null : toInt(row.edit_seq);
  if (row.part === "create" && row.entity === "checklist") {
    const templateId = toText(v.template_id);
    return {
      ...base,
      kind: "create_checklist",
      deal_id: ctx.cloudDealId,
      local_id: row.local_id,
      template_id: templateId ?? "",
      template_name: toText(v.template_name),
      sort_order: toInt(v.sort_order),
      is_private: isPrivateChecklist(templateId),
    };
  }
  if (row.part === "create" && row.entity === "item") {
    return {
      ...base,
      kind: "create_item",
      deal_id: ctx.cloudDealId,
      checklist_local_id: toText(v.checklist_id) ?? "",
      local_id: row.local_id,
      ...(ctx.checklistCloudId ? { checklist_id: ctx.checklistCloudId } : {}),
      title: toText(v.title) ?? "",
      description: toText(v.description),
      is_required: toBool(v.is_required),
      expected_document_type: toText(v.expected_document_type),
      local_created_at: instant(v.created_at),
      done: partValue("done", v),
      note: partValue("note", v),
      due_date: partValue("due", v),
      sort_order: partValue("order", v),
      edit_seq: editSeq,
    };
  }
  if (row.part === "removed" && (row.entity === "item" || row.entity === "checklist")) {
    return { ...base, kind: "remove", entity: row.entity, deal_id: ctx.cloudDealId, local_id: row.local_id, ...(ctx.todoCloudId ? { id: ctx.todoCloudId } : {}) };
  }
  if (isPart(row.entity, row.part)) {
    return {
      ...base,
      kind: "set",
      entity: row.entity,
      deal_id: ctx.cloudDealId,
      local_id: row.local_id,
      ...(ctx.todoCloudId ? { id: ctx.todoCloudId } : {}),
      part: row.part,
      value: partValue(row.part, v),
      base_rev: row.base_rev === null || row.base_rev === undefined ? null : toInt(row.base_rev),
      edit_seq: editSeq,
      // PR-4b: the puller kept this computer's value on a locked deal (plan §2.4); the server records it as held_locked.
      ...(v[HELD_LOCKED_KEY] === true || v[HELD_LOCKED_KEY] === 1 ? { held_locked: true } : {}),
    };
  }
  return null;
}

/**
 * Send order (PR-3 review N2): every create before any part, parts before removals, checklists before
 * their items on create and after them on removal. Within a rank: edit_seq, then edited_at (edit_seq is
 * NULL without a counter row, and a re-edited part keeps its first rowid, so rowid is not used).
 */
export function sendRank(row: Pick<OutboxRow, "entity" | "part">): number {
  if (row.part === "create") return row.entity === "checklist" ? 0 : 1;
  if (row.part === "removed") return row.entity === "item" ? 4 : 5;
  return row.entity === "checklist" ? 2 : 3;
}

export function compareForSend(a: OutboxRow, b: OutboxRow): number {
  const r = sendRank(a) - sendRank(b);
  if (r !== 0) return r;
  const ea = a.edit_seq ?? Number.MAX_SAFE_INTEGER;
  const eb = b.edit_seq ?? Number.MAX_SAFE_INTEGER;
  if (ea !== eb) return ea - eb;
  if (a.edited_at !== b.edited_at) return a.edited_at < b.edited_at ? -1 : 1;
  const ka = `${a.entity}:${a.local_id}:${a.part}`;
  const kb = `${b.entity}:${b.local_id}:${b.part}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** The parts a create op carries (a create answer's write-back covers these). */
export function partsOfCreate(entity: string): readonly TodoPart[] {
  return entity === "item" ? ITEM_PARTS : entity === "checklist" ? CHECKLIST_PARTS : [];
}
