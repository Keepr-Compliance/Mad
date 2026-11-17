/**
 * An in-memory stand-in for the Keepr Cloud RPCs (BACKLOG-4243 tests).
 *
 * Envelopes are transcribed from
 * supabase/migrations/20261112190000_backlog_4236_cloud_autosave_schema.sql:
 *   get_my_cloud_autosave_state          :509-520 (bare object, schema_version 1)
 *   set_my_cloud_autosave                :531-532 refusals, :547 on, :569 off
 *   cloud_upsert_deal                    :675-676 refusals, :743-744 results[0]
 *     {local_id, cloud_id, version, content_hash, status}; status from
 *     _cloud_row_status :385 (unchanged when the hash matches)
 *   cloud_delete_deal                    :1216-1217 refusals, :1223 not_found, :1234 ok
 *   cloud_mark_deal_synced               :1244-1245 refusals, :1254 not_found, :1257 ok
 *   cloud_upsert_parties / _checklists / _checklist_items   results
 *     {local_id, cloud_id, version, content_hash, status}; rejected rows
 *     {local_id, status:"rejected", reason}; item parent lookup (ITEM:parent);
 *     party flip (PTY:flip: an equal-hash resend that turns withholding on is applied)
 *   cloud_tombstone                      results {cloud_id, status removed|unchanged|not_found, version}
 *   cloud_list_installs                  :575-588 bare {installs:[{source_install_id, deals, last_synced_at}]}
 *   cloud_delete_install                 :593-615 {success:true, deleted_deals, blobs_fenced}
 *   cloud_list_install_rows              migration 20261114130000 {ok, rows:[{cloud_id, cloud_deal_id,
 *     local_id, content_hash, removed}], next_after}
 * `wrong_account` whenever p_expected_user_id differs from the token's user.
 *
 * BACKLOG-4263 PR-4a — cloud_todo_push, transcribed (not run: PR-2 is not applied on the test database
 * yet) from origin/feature/BACKLOG-4263-todo-server-core @ fa0d63778 (push side re-read at 96bb1ca67:
 * unchanged; the field_types table below equals that head's contract, checked by diff):
 *   supabase/migrations/20261118110000_backlog_4263_todo_server_core.sql
 *     cloud_todo_push :948-977   refusals not_authorized / wrong_account / invalid_input / not_entitled /
 *                                install_removed / batch_too_large; age = p_sent_at - edited_at, unknowable
 *                                (-infinity) when < 0, > 365 d, missing, or clock_stepped
 *     _cloud_todo_apply :862-941 {ok:true, results:[...]}; replay of a kept op_id; ledger rule
 *                                _cloud_todo_recorded :246-250 (not kept: not_found, locked,
 *                                refused_removed, install_removed, reason parent_missing / my_items_exists)
 *     _cloud_todo_apply_op :513-854 the type gate :532-543, create_checklist (added / exists / mapped),
 *                                create_item (added / exists merging every carried part with no base /
 *                                rejected parent_missing), set (equal -> unchanged, causal on base or a
 *                                later edit_seq of the same install, else later effective time wins ->
 *                                applied with conflict or lost; on a removed row applied_to_removed), remove
 *                                (removed / already_removed); answer {op_id, status, entity, cloud_id,
 *                                local_id, cloud_deal_id, parts, conflict}
 *     _cloud_todo_item_json :328-346, _cloud_todo_checklist_json :349-361 the parts shape {rev, value, at, by,
 *                                edit_seq}
 *   supabase/contracts/cloud-todo-change-v1.json field_types (the per-field JSON type lists below)
 *   supabase/tests/backlog-4263-pr2/results-2026-11-17.txt answer samples, e.g.
 *     {"ok": true, "results": [{"op_id": "<uuid>", "parts": {"due": {"at": "…", "by": "desktop:<uuid>", "rev": 1,
 *      "value": null, "edit_seq": null}, …}, …}]} and {"op_id": "<uuid>", "entity": "item", "status": "locked", …}
 * The answers to RE-CHECK against the applied functions are listed in the PR-4a handoff.
 */
import type { RpcTransport, RpcResponse } from "../../cloudClient";
import type { JsonValue } from "../../jcs";

/** Contract field_types (cloud-todo-change-v1.json @ 00bd934db: fa0d63778's list plus checklist_id). base_rev / edit_seq: integers only. */
export const TODO_FIELD_TYPES: Record<string, readonly string[]> = {
  entity: ["string"],
  id: ["string"],
  deal_id: ["string"],
  local_id: ["string"],
  checklist_local_id: ["string"],
  checklist_id: ["string"],
  template_id: ["string"],
  template_name: ["string", "null"],
  sort_order: ["number", "null"],
  is_private: ["boolean", "null"],
  title: ["string"],
  note: ["string", "null"],
  due_date: ["string", "null"],
  done: ["boolean", "object"],
  description: ["string", "null"],
  is_required: ["boolean", "null"],
  expected_document_type: ["string", "null"],
  local_created_at: ["string", "null"],
  part: ["string"],
  base_rev: ["integer", "null"],
  edit_seq: ["integer", "null"],
  clock_stepped: ["boolean", "null"],
  held_locked: ["boolean", "null"],
};

export function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return "number";
  return typeof v;
}

/** The per-op type gate (migration :532-543): the fields whose JSON type is outside their list. */
export function badTodoFields(op: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const [k, types] of Object.entries(TODO_FIELD_TYPES)) {
    if (!(k in op)) continue;
    const v = op[k];
    const t = jsonType(v);
    const ok = types.some((x) => (x === "integer" ? typeof v === "number" && Number.isInteger(v) : x === t));
    if (!ok) bad.push(k);
  }
  return bad.sort();
}

/**
 * The per-part value rule (_cloud_todo_norm, migration :374-411; contract wire_types @ 00bd934db): done is a
 * boolean or {is_checked: boolean, checked_at}; title a string; note string|null; due YYYY-MM-DD|null; order an
 * integer|null. Returns the part name when the value is refused.
 */
export function badPartValue(part: string, v: unknown): string | null {
  const t = jsonType(v);
  switch (part) {
    case "done":
      return t === "boolean" || (t === "object" && jsonType((v as Record<string, unknown>).is_checked) === "boolean") ? null : part;
    case "title":
      return t === "string" ? null : part;
    case "note":
      return t === "string" || t === "null" ? null : part;
    case "due":
      return t === "null" || (t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v as string)) ? null : part;
    case "order":
      return t === "null" || (t === "number" && Number.isInteger(v)) ? null : part;
    default:
      return part;
  }
}

/** Contract wire_types examples (@ 00bd934db), verbatim apart from <uuid> placeholders. */
export const WIRE_EXAMPLES = {
  accepted: [
    { kind: "set", entity: "item", id: "<uuid>", part: "done", value: { is_checked: true, checked_at: "2026-11-17T04:05:08.266Z" }, base_rev: 1, edit_seq: 3, edited_at: "2026-11-17T04:05:08.266Z" },
    { kind: "set", entity: "item", id: "<uuid>", part: "title", value: "Call lender" },
    { kind: "create_item", deal_id: "<uuid>", checklist_local_id: "cl1", local_id: "i9", title: "Order survey", is_required: false, done: false },
  ] as Array<Record<string, unknown>>,
  refused: [
    { why: "is_required as 1", op: { kind: "create_item", is_required: 1 } },
    { why: "done.is_checked as 1", op: { kind: "set", part: "done", value: { is_checked: 1 } } },
    { why: "part value wrapped by part name", op: { kind: "set", part: "title", value: { title: "Call lender" } } },
  ] as Array<{ why: string; op: Record<string, unknown> }>,
};

/** The whole per-op check: the field types plus the part value of a set and the done of a create. */
export function refusedFields(op: Record<string, unknown>): string[] {
  const bad = badTodoFields(op);
  if (op.kind === "set" && typeof op.part === "string") {
    const b = badPartValue(op.part, op.value ?? null);
    if (b) bad.push(`value:${b}`);
  }
  if (op.kind === "create_item" && "done" in op) {
    const b = badPartValue("done", op.done);
    if (b) bad.push("done");
  }
  return [...new Set(bad)].sort();
}

export interface FakeTodoPart {
  rev: number;
  value: JsonValue;
  /** Effective time in ms (-Infinity = unknowable). */
  at: number;
  by: string;
  edit_seq: number | null;
}
export interface FakeTodo {
  id: string;
  owner: string;
  dealId: string;
  entity: "item" | "checklist";
  localId: string;
  checklistId: string | null;
  templateId: string | null;
  removed: boolean;
  parts: Record<string, FakeTodoPart>;
  /** Contract my_items (@ 00bd934db): other local ids a `mapped` answer recorded for this list. */
  aliases?: string[];
}

export interface FakeDeal {
  id: string;
  owner: string;
  install: string;
  localId: string;
  hash: string;
  version: number;
  fullSyncAt: string | null;
  lastSyncedAt?: string;
}

export type FakeKind = "party" | "checklist" | "checklist_item";
export interface FakeChild {
  id: string;
  owner: string;
  dealId: string;
  kind: FakeKind;
  localId: string;
  hash: string;
  version: number;
  removed: boolean;
  withheld: boolean;
  checklistId: string | null;
  row: Record<string, JsonValue>;
}

export const DROPPED_FUNCTIONS = ["cloud_upsert_checklists", "cloud_upsert_checklist_items"];
export const READ_FUNCTIONS = ["get_my_cloud_autosave_state", "cloud_list_install_rows", "cloud_list_installs"];

export type Override = (fn: string, args: Record<string, JsonValue>) => RpcResponse | Error | undefined;

let idSeq = 0;
const cloudId = () => `00000000-0000-0000-0000-c${String(++idSeq).padStart(11, "0")}`;

export class FakeServer {
  /** The user the Supabase token belongs to (auth.uid()). */
  tokenUser: string | null;
  licensed = true;
  enabled = true;
  noticeVersion = 1;
  currentNoticeVersion = 1;
  acceptedAt: string | null = "2026-11-01T00:00:00.000Z";
  reason: string | null | undefined = undefined;
  deals: FakeDeal[] = [];
  children: FakeChild[] = [];
  calls: Array<{ fn: string; args: Record<string, JsonValue> }> = [];
  override: Override | null = null;
  /** BACKLOG-4263: todo rows (cloud_deal_checklists / _items under the new protocol), ledger, register. */
  todos: FakeTodo[] = [];
  todoLedger = new Map<string, JsonValue>();
  removedInstalls = new Set<string>();
  /** Deals removed by cloud_delete_deal: PR-2 keeps them (soft) with their todos. */
  softRemovedDeals: FakeDeal[] = [];
  /** The server's clock for receive times (ms). */
  serverNow = () => Date.parse("2026-11-14T12:00:05.000Z");

  constructor(user: string) {
    this.tokenUser = user;
  }

  callsTo(fn: string) {
    return this.calls.filter((c) => c.fn === fn);
  }

  writeCalls() {
    return this.calls.filter((c) => !READ_FUNCTIONS.includes(c.fn));
  }

  private entitled() {
    return this.licensed && this.enabled && this.noticeVersion === this.currentNoticeVersion;
  }

  transport: RpcTransport = async (fn, args) => {
    this.calls.push({ fn, args });
    const o = this.override?.(fn, args);
    if (o instanceof Error) throw o;
    if (o) return o;
    // Dropped by migration 20261118120000 (BACKLOG-4263 PR-4a). PostgREST's answer for a function that does
    // not exist: HTTP 404, code PGRST202 (UNOBSERVED on the test database; PostgREST error reference).
    if (DROPPED_FUNCTIONS.includes(fn)) return { data: null, error: { code: "PGRST202", status: 404 }, status: 404 };
    return { data: this.handle(fn, args), error: null, status: 200 };
  };

  /** The response the contract would give, without recording a call. */
  respond(fn: string, a: Record<string, JsonValue>): unknown {
    return this.handle(fn, a);
  }

  private handle(fn: string, a: Record<string, JsonValue>): unknown {
    const uid = this.tokenUser;
    if (fn === "get_my_cloud_autosave_state") {
      const entitled = this.entitled();
      const reason =
        this.reason !== undefined ? this.reason
        : entitled ? null
        : !this.licensed ? "no_license"
        : !this.enabled ? "not_enabled"
        : "notice_outdated";
      return {
        schema_version: 1,
        user_id: uid,
        licensed: this.licensed,
        entitled: this.reason !== undefined ? false : entitled,
        path: this.licensed ? "solo" : null,
        organization_id: null,
        reason,
        settings: { enabled: this.enabled, notice_version: this.noticeVersion, accepted_at: this.acceptedAt },
        current_notice_version: this.currentNoticeVersion,
        storage: { used_bytes: 0, quota_bytes: null },
      };
    }
    const okKey = fn === "set_my_cloud_autosave" || fn === "cloud_delete_install" ? "success" : "ok";
    if (!uid) return { [okKey]: false, error: fn === "set_my_cloud_autosave" || fn === "cloud_delete_deal" ? "not_authorized" : "not_entitled" };
    if (fn !== "cloud_list_installs" && a.p_expected_user_id !== uid) return { [okKey]: false, error: "wrong_account" };
    switch (fn) {
      case "set_my_cloud_autosave": {
        if (a.p_enabled === true) {
          if (!this.licensed) return { success: false, error: "not_licensed" };
          if (a.p_notice_version !== this.currentNoticeVersion) return { success: false, error: "notice_outdated" };
          this.enabled = true;
          this.noticeVersion = a.p_notice_version as number;
          this.acceptedAt = "2026-11-14T10:00:00.000Z";
          return { success: true, enabled: true };
        }
        this.enabled = false;
        this.todos = this.todos.filter((t) => t.owner !== uid);
        for (const k of [...this.todoLedger.keys()]) if (k.startsWith(`${uid}|`)) this.todoLedger.delete(k);
        for (const k of [...this.removedInstalls]) if (k.startsWith(`${uid}|`)) this.removedInstalls.delete(k);
        this.softRemovedDeals = this.softRemovedDeals.filter((d) => d.owner !== uid);
        const n = this.deals.filter((d) => d.owner === uid).length;
        this.deals = this.deals.filter((d) => d.owner !== uid);
        this.children = this.children.filter((c) => c.owner !== uid);
        return { success: true, enabled: false, deleted: { deals: n }, blobs_fenced: 0, ai_apps_disconnected: null };
      }
      case "cloud_upsert_deal": {
        if (!this.entitled()) return { ok: false, error: "not_entitled" };
        const p = a.p_deal as Record<string, JsonValue>;
        const key = (d: FakeDeal) => d.owner === uid && d.install === p.source_install_id && d.localId === p.local_id;
        let d = this.deals.find(key);
        let status = "applied";
        // PR-2 (observed on the test database, harness-4a C16): a soft-removed deal uploaded again by its install
        // is un-removed under the SAME id, its todos with it
        const soft = !d ? this.softRemovedDeals.find(key) : undefined;
        if (soft) {
          this.softRemovedDeals = this.softRemovedDeals.filter((x) => x !== soft);
          this.deals.push(soft);
          d = soft;
        }
        if (!d) {
          d = { id: cloudId(), owner: uid, install: p.source_install_id as string, localId: p.local_id as string, hash: "", version: 0, fullSyncAt: null };
          this.deals.push(d);
        }
        if (d.version > 0 && d.hash === p.content_hash) status = "unchanged";
        else {
          d.hash = p.content_hash as string;
          d.version += 1;
        }
        return { ok: true, results: [{ local_id: d.localId, cloud_id: d.id, version: d.version, content_hash: d.hash, status }] };
      }
      case "cloud_delete_deal": {
        const i = this.deals.findIndex((d) => d.id === a.p_cloud_deal_id && d.owner === uid);
        if (i < 0) return { ok: false, error: "not_found" };
        const gone = this.deals.splice(i, 1)[0];
        this.children = this.children.filter((c) => c.dealId !== gone.id);
        this.softRemovedDeals.push(gone);
        return { ok: true, deleted: { parties: 0, checklists: 0, checklist_items: 0, messages: 0, files: 0 }, blobs_fenced: 0 };
      }
      case "cloud_mark_deal_synced": {
        if (!this.entitled()) return { ok: false, error: "not_entitled" };
        const d = this.deals.find((x) => x.id === a.p_cloud_deal_id && x.owner === uid && x.install === a.p_source_install_id);
        if (!d) return { ok: false, error: "not_found" };
        d.fullSyncAt = "2026-11-14T10:00:01.000Z";
        return { ok: true, last_full_sync_at: d.fullSyncAt };
      }
      case "cloud_todo_push":
        return this.todoPush(uid, a);
      case "cloud_upsert_parties":
      case "cloud_upsert_checklists":
      case "cloud_upsert_checklist_items": {
        if (!this.entitled()) return { ok: false, error: "not_entitled" };
        const kind: FakeKind = fn === "cloud_upsert_parties" ? "party" : fn === "cloud_upsert_checklists" ? "checklist" : "checklist_item";
        const deal = this.deals.find((d) => d.id === a.p_cloud_deal_id && d.owner === uid && d.install === a.p_source_install_id);
        if (!deal) return { ok: false, error: "not_found" };
        const rows = a.p_rows as Array<Record<string, JsonValue>>;
        if (!Array.isArray(rows)) return { ok: false, error: "invalid_input" };
        const out: JsonValue[] = [];
        for (const r of rows) {
          let parent: FakeChild | undefined;
          if (kind === "checklist_item") {
            parent = this.children.find(
              (c) => c.kind === "checklist" && c.dealId === deal.id && c.localId === r.local_checklist_id && !c.removed,
            );
            if (!parent) {
              out.push({ local_id: r.local_id, status: "rejected", reason: "parent_missing" });
              continue;
            }
          }
          let c = this.children.find((x) => x.kind === kind && x.dealId === deal.id && x.localId === r.local_id);
          if (!c) {
            c = { id: cloudId(), owner: uid, dealId: deal.id, kind, localId: r.local_id as string, hash: "", version: 0, removed: false, withheld: false, checklistId: null, row: {} };
            this.children.push(c);
          }
          const withheld = r.details_withheld === true;
          let status = c.version > 0 && !c.removed && c.hash === r.content_hash ? "unchanged" : "applied";
          if (status === "unchanged" && kind === "party" && withheld && !c.withheld) status = "applied";
          if (status === "applied") {
            c.hash = r.content_hash as string;
            c.version += 1;
            c.removed = false;
            c.withheld = withheld;
            c.checklistId = parent?.id ?? null;
            c.row = { ...r };
          }
          out.push({ local_id: c.localId, cloud_id: c.id, version: c.version, content_hash: c.hash, status });
        }
        return { ok: true, results: out };
      }
      case "cloud_tombstone": {
        const out: JsonValue[] = [];
        for (const id of a.p_cloud_ids as string[]) {
          const c = this.children.find((x) => x.id === id && x.owner === uid && x.kind === a.p_kind);
          const deal = c && this.deals.find((d) => d.id === c.dealId && d.install === a.p_source_install_id);
          if (!c || !deal) {
            out.push({ cloud_id: id, status: "not_found" });
            continue;
          }
          if (c.removed) {
            out.push({ cloud_id: id, status: "unchanged", version: c.version });
            continue;
          }
          c.removed = true;
          c.version += 1;
          if (c.kind === "checklist") {
            for (const it of this.children) if (it.kind === "checklist_item" && it.checklistId === c.id && !it.removed) {
              it.removed = true;
              it.version += 1;
            }
          }
          out.push({ cloud_id: id, status: "removed", version: c.version });
        }
        return { ok: true, results: out };
      }
      case "cloud_list_install_rows": {
        const kind = a.p_kind as string;
        if (!["deal", "party", "checklist", "checklist_item"].includes(kind)) return { ok: false, error: "invalid_input" };
        const limit = Math.min(Math.max(Number(a.p_limit) || 0, 1), 1000);
        const all =
          kind === "deal"
            ? this.deals
                .filter((d) => d.owner === uid && d.install === a.p_source_install_id)
                .map((d) => ({ cloud_id: d.id, cloud_deal_id: d.id, local_id: d.localId, content_hash: d.hash, removed: false }))
            : this.children
                .filter((c) => c.owner === uid && c.kind === kind && this.deals.some((d) => d.id === c.dealId && d.install === a.p_source_install_id))
                .map((c) => ({ cloud_id: c.id, cloud_deal_id: c.dealId, local_id: c.localId, content_hash: c.hash, removed: c.removed }));
        all.sort((x, y) => (x.cloud_id < y.cloud_id ? -1 : 1));
        const after = typeof a.p_after === "string" ? a.p_after : null;
        const page = all.filter((x) => after === null || x.cloud_id > after).slice(0, limit);
        return { ok: true, rows: page, next_after: page.length === limit ? page[page.length - 1].cloud_id : null };
      }
      case "cloud_list_installs": {
        const by = new Map<string, { n: number; at: string }>();
        for (const d of this.deals.filter((x) => x.owner === uid)) {
          const cur = by.get(d.install) ?? { n: 0, at: "" };
          const at = d.lastSyncedAt ?? "2026-11-14T10:00:00.000Z";
          by.set(d.install, { n: cur.n + 1, at: at > cur.at ? at : cur.at });
        }
        return { installs: [...by.entries()].map(([k, v]) => ({ source_install_id: k, deals: v.n, last_synced_at: v.at })) };
      }
      case "cloud_delete_install": {
        this.removedInstalls.add(`${uid}|${a.p_source_install_id}`);
        const gone = this.deals.filter((d) => d.owner === uid && d.install === a.p_source_install_id);
        this.deals = this.deals.filter((d) => !gone.includes(d));
        this.children = this.children.filter((c) => !gone.some((d) => d.id === c.dealId));
        return { success: true, deleted_deals: gone.length, blobs_fenced: 0 };
      }
      default:
        throw new Error(`unexpected rpc ${fn}`);
    }
  }

  // ------------------------------------------------------------ cloud_todo_push (BACKLOG-4263, see header)

  private todoJson(t: FakeTodo): JsonValue {
    const parts: Record<string, JsonValue> = {};
    for (const [k, p] of Object.entries(t.parts)) {
      parts[k] = { rev: p.rev, value: p.value, at: Number.isFinite(p.at) ? new Date(p.at).toISOString() : "-infinity", by: p.by, edit_seq: p.edit_seq };
    }
    return parts;
  }

  private todoAnswer(opId: string, status: string, t: FakeTodo, conflict = false): Record<string, JsonValue> {
    return { op_id: opId, status, entity: t.entity, cloud_id: t.id, local_id: t.localId, cloud_deal_id: t.dealId, parts: this.todoJson(t), conflict };
  }

  private todoDeal(uid: string, install: string, dealId: unknown): { deal: FakeDeal; removed: boolean } | null {
    const live = this.deals.find((d) => d.id === dealId && d.owner === uid && d.install === install);
    if (live) return { deal: live, removed: false };
    const soft = this.softRemovedDeals.find((d) => d.id === dealId && d.owner === uid && d.install === install);
    return soft ? { deal: soft, removed: true } : null;
  }

  /** One part merge (migration :793-845), desktop actor. */
  private mergePart(t: FakeTodo, part: string, value: JsonValue, op: Record<string, JsonValue>, by: string, eff: number, onRemoved: boolean) {
    const cur = t.parts[part];
    const same =
      part === "done"
        ? !!(cur.value as Record<string, JsonValue>)?.is_checked === !!(value as Record<string, JsonValue>)?.is_checked
        : JSON.stringify(cur.value) === JSON.stringify(value);
    if (same) return { status: "unchanged", conflict: false };
    const base = typeof op.base_rev === "number" ? op.base_rev : null;
    const es = typeof op.edit_seq === "number" ? op.edit_seq : null;
    const write = () => {
      t.parts[part] = { rev: cur.rev + 1, value, at: Math.max(cur.at, eff), by, edit_seq: es };
    };
    if (base === cur.rev || (cur.by === by && es !== null && es > (cur.edit_seq ?? -1))) {
      write();
      return { status: onRemoved ? "applied_to_removed" : "applied", conflict: false };
    }
    const curKind = cur.by.split(":")[0];
    const wins = eff > cur.at || (eff === cur.at && "desktop" > curKind);
    if (wins) {
      write();
      return { status: onRemoved ? "applied_to_removed" : "applied", conflict: true };
    }
    return { status: "lost", conflict: true };
  }

  private todoPush(uid: string, a: Record<string, JsonValue>): unknown {
    if (!this.entitled()) return { ok: false, error: "not_entitled" };
    const install = a.p_source_install_id as string;
    if (!install) return { ok: false, error: "invalid_input" };
    if (this.removedInstalls.has(`${uid}|${install}`)) return { ok: false, error: "install_removed" };
    const ops = a.p_ops as Array<Record<string, JsonValue>>;
    if (!Array.isArray(ops)) return { ok: false, error: "invalid_input" };
    if (ops.length > 200 || JSON.stringify(ops).length > 1048576) return { ok: false, error: "batch_too_large" };
    const hex = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op !== "object" || typeof op.op_id !== "string" || !hex.test(op.op_id) || typeof op.kind !== "string" ||
          !["create_checklist", "create_item", "set", "remove", "restore"].includes(op.kind as string)) {
        return { ok: false, error: "invalid_input", detail: { index: i } };
      }
    }
    const sent = typeof a.p_sent_at === "string" ? Date.parse(a.p_sent_at) : NaN;
    const recv = this.serverNow();
    const by = `desktop:${install}`;
    const out: JsonValue[] = [];
    for (const op of ops) {
      const h = (op.op_id as string).replace(/-/g, "").toLowerCase();
      const opId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      const lk = `${uid}|${opId}`;
      const kept = this.todoLedger.get(lk);
      if (kept !== undefined) {
        out.push(kept);
        continue;
      }
      const r = this.todoApplyOp(uid, install, by, op, opId, sent, recv);
      const notKept = ["not_found", "locked", "refused_removed", "install_removed"].includes(String(r.status)) ||
        ["parent_missing", "my_items_exists"].includes(String(r.reason ?? ""));
      if (!notKept) this.todoLedger.set(lk, r);
      out.push(r);
    }
    return { ok: true, results: out };
  }

  private todoApplyOp(uid: string, install: string, by: string, op: Record<string, JsonValue>, opId: string, sent: number, recv: number): Record<string, JsonValue> {
    const bad = refusedFields(op);
    // @ 0c6edef8f: ids are compared as uuids; a malformed id answers rejected/invalid_value (kept, final)
    const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
    for (const k of ["id", "deal_id", "checklist_id"]) if (typeof op[k] === "string" && !UUID.test(op[k] as string)) bad.push(k);
    if (bad.length > 0) return { op_id: opId, status: "rejected", reason: "invalid_value", field: bad.join(",") };
    const edited = typeof op.edited_at === "string" ? Date.parse(op.edited_at) : NaN;
    const age = sent - edited;
    const eff = !Number.isFinite(age) || age < 0 || age > 365 * 86400000 || op.clock_stepped === true ? -Infinity : recv - age;
    const es = typeof op.edit_seq === "number" ? op.edit_seq : null;
    const kind = op.kind as string;
    if (kind === "create_checklist" || kind === "create_item") {
      const dl = this.todoDeal(uid, install, op.deal_id);
      if (!dl) return { op_id: opId, status: "not_found" };
      const deal = dl.deal;
      if (kind === "create_checklist") {
        const ex = this.todos.find((t) => t.entity === "checklist" && t.dealId === deal.id && t.localId === op.local_id);
        if (ex) return this.todoAnswer(opId, "exists", ex);
        const alias = this.todos.find((t) => t.entity === "checklist" && t.dealId === deal.id && (t.aliases ?? []).includes(op.local_id as string));
        if (alias) return this.todoAnswer(opId, "mapped", alias);
        if (op.template_id === "keepr:my-items") {
          const my = this.todos.find((t) => t.entity === "checklist" && t.dealId === deal.id && t.templateId === "keepr:my-items" && !t.removed);
          if (my) {
            my.aliases = [...(my.aliases ?? []), op.local_id as string];
            return this.todoAnswer(opId, "mapped", my);
          }
        }
        const t: FakeTodo = {
          id: cloudId(), owner: uid, dealId: deal.id, entity: "checklist", localId: op.local_id as string, checklistId: null,
          templateId: op.template_id as string, removed: false,
          parts: {
            order: { rev: 1, value: (op.sort_order ?? null) as JsonValue, at: eff, by, edit_seq: es },
            removed: { rev: 1, value: { removed_at: null, kind: null }, at: eff, by, edit_seq: null },
          },
        };
        this.todos.push(t);
        return this.todoAnswer(opId, "added", t);
      }
      const cl = this.todos.find(
        (t) =>
          t.entity === "checklist" &&
          t.dealId === deal.id &&
          (op.checklist_id !== undefined ? t.id === op.checklist_id : t.localId === op.checklist_local_id || (t.aliases ?? []).includes(op.checklist_local_id as string)),
      );
      if (!cl) return { op_id: opId, status: "rejected", reason: "parent_missing" };
      const done = op.done && typeof op.done === "object" ? (op.done as Record<string, JsonValue>) : { is_checked: op.done === true, checked_at: null };
      const values: Record<string, JsonValue> = {
        done: { is_checked: done.is_checked === true, checked_at: done.is_checked === true ? (done.checked_at ?? new Date(recv).toISOString()) : null },
        title: (op.title ?? null) as JsonValue,
        note: (op.note ?? null) as JsonValue,
        due: (op.due_date ?? null) as JsonValue,
        order: (op.sort_order ?? null) as JsonValue,
      };
      const ex = this.todos.find((t) => t.entity === "item" && t.dealId === deal.id && t.localId === op.local_id);
      if (ex) {
        let conflict = false;
        for (const p of ["done", "title", "note", "due", "order"]) {
          const r = this.mergePart(ex, p, values[p], { edit_seq: es } as Record<string, JsonValue>, by, eff, ex.removed || dl.removed);
          conflict = conflict || r.conflict;
        }
        return this.todoAnswer(opId, "exists", ex, conflict);
      }
      const t: FakeTodo = {
        id: cloudId(), owner: uid, dealId: deal.id, entity: "item", localId: op.local_id as string, checklistId: cl.id, templateId: null, removed: false,
        parts: {
          ...Object.fromEntries(["done", "title", "note", "due", "order"].map((p) => [p, { rev: 1, value: values[p], at: eff, by, edit_seq: es }])),
          removed: { rev: 1, value: { removed_at: null, kind: null }, at: eff, by, edit_seq: null },
        },
      };
      this.todos.push(t);
      return this.todoAnswer(opId, "added", t);
    }
    const ent = (op.entity as string) ?? "item";
    const dl = this.todoDeal(uid, install, op.deal_id);
    const t = dl
      ? this.todos.find((x) => x.entity === ent && x.dealId === dl.deal.id && (x.localId === op.local_id || (x.aliases ?? []).includes(op.local_id as string)))
      : undefined;
    if (!dl || !t) return { op_id: opId, status: "not_found" };
    const parent = t.checklistId ? this.todos.find((x) => x.id === t.checklistId) : undefined;
    const onRemoved = t.removed || dl.removed || !!parent?.removed;
    if (kind === "remove") {
      // contract my_items.list_removal: a My items list goes only with its deal, for every actor
      if (ent === "checklist" && t.templateId === "keepr:my-items") return { op_id: opId, status: "not_allowed", entity: ent, cloud_id: t.id };
      if (t.removed) return this.todoAnswer(opId, "already_removed", t);
      const cur = t.parts.removed;
      t.parts.removed = { rev: cur.rev + 1, value: { removed_at: new Date(recv).toISOString(), kind: ent }, at: Math.max(cur.at, eff), by, edit_seq: es };
      t.removed = true;
      return this.todoAnswer(opId, "removed", t);
    }
    if (kind !== "set") return { op_id: opId, status: "rejected", reason: "invalid_value", field: "kind" };
    const part = op.part as string;
    if (!(part in t.parts) || part === "removed") return { op_id: opId, status: "rejected", reason: "invalid_value", field: "part" };
    const r = this.mergePart(t, part, (op.value ?? null) as JsonValue, op, by, eff, onRemoved);
    return this.todoAnswer(opId, r.status, t, r.conflict);
  }
}
