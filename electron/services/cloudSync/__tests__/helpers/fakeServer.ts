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
 *
 * BACKLOG-4263 PR-4b — the change feed and the calls around it, transcribed from the same migration (this tree)
 * and checked against the real functions by supabase/tests/backlog-4263-pr4b/harness-4b.sql (keepr-test, rolled
 * back; observed shapes in that file's handback):
 *   cloud_todo_pull :1018-1075   {ok, head, rows, horizon, next_after, install_max_edit_seq, resync_required};
 *                                horizon_required when p_after_seq > 0 without p_horizon; rows of this owner's
 *                                deals of this install only, in change_seq order, (after, head], at most p_limit;
 *                                next_after = the last number of a full page, else greatest(head, after);
 *                                resync_required = after > head OR (after > 0 AND forgotten_at > horizon AND
 *                                forgotten_through_seq > after); install_max_edit_seq = the highest edit_seq of a
 *                                part this install wrote (null when none). Row shapes: _cloud_todo_item_json
 *                                :331-350, _cloud_todo_checklist_json :352-366 (a purged row: ids and purged:true
 *                                only), deal {entity, cloud_id, local_id, change_seq, removed_at, removed_kind,
 *                                restorable_until}, event {entity:'event', change_seq, cloud_deal_id, about,
 *                                cloud_id, part, outcome, loser_value, winner_value, by, label, other_by,
 *                                effective_at, received_at}.
 *   numbering (_cloud_todo_take_seq, _cloud_todo_write_part :419-457): every write of a part, a create, a removal,
 *                                a restore and a conflict event takes a new number; an equal value takes none for
 *                                the row (observed O3: this install's own change comes back with the answer's rev).
 *   conflict events (:860-869): applied with conflict -> loser = the stored value, winner = the incoming one;
 *                                lost -> loser = the incoming value, winner = the stored one; by = the incoming actor.
 *   _cloud_todo_unremove_deal :487-514 (F4): the deal and its live checklists and items take new numbers.
 *   cloud_todo_restore of a checklist does NOT renumber its items (observed O5f: 0 item rows in the next pull).
 *   cloud_delete_deal / cloud_delete_install: soft removal (removed_kind deal / install) with a new deal number;
 *                                cloud_list_install_rows lists a soft-removed deal with removed:true (observed O9c);
 *                                a removed install's pull still answers (observed O10b), its writes answer
 *                                install_removed.
 *   cloud_install_status :1210-1224 {ok, removed}; cloud_reclaim_install :1193-1208 {ok, removed_entry}, the delete
 *                                keyed on the caller (observed O10c: B's register row stays).
 *   _cloud_todo_purge :1261-  an item or checklist removed > 30 days: purged (no content) with a new number; the
 *                                owner's forgotten_through_seq rises to the deleted numbers and forgotten_at takes
 *                                a new number (observed O8b-d).
 *   BACKLOG-4263 PR-4c, observed on the test database by supabase/tests/backlog-4263-pr4c/harness-4c.sql
 *   (results: harness-4c.results.json):
 *   cloud_delete_deal of a deal already removed: ok again (Q1b); of a purged deal: not_found (Q2j).
 *   cloud_purge_deal_now :1358-1375 + _cloud_todo_purge_deal :1227-1259: a live deal -> {ok:false, error:
 *                                not_removed} (Q2a, Q4c, Q5c); another owner's deal or none -> {ok:true, status:
 *                                not_found} (Q2d, Q2i); a removed deal -> {ok:true, status: purged}, the deal, its
 *                                checklists, items and history gone, forgotten_through_seq and forgotten_at raised, so
 *                                a pull from before it answers resync_required (Q2g, Q2h, Q2k); wrong_account (Q2b),
 *                                invalid_input for a NULL id (Q2c).
 *   cloud_upsert_deal of a purged deal's local id: a NEW online deal (Q3); of a removed one: the same id, status
 *                                unchanged when the hash is equal, restored:true, children renumbered (Q4, Q4b).
 *   cloud_todo_restore of a deal (another side's restore): status restored; the next pull carries the deal row
 *                                (removed_at null, local_id = the desktop's) and its live children renumbered (Q5, Q5b).
 *
 * BACKLOG-4263 P2 — one computer per account, transcribed from the merged (not yet applied anywhere) migration
 * supabase/migrations/20261123100000_backlog_4263_one_computer.sql:
 *   get_my_cloud_autosave_state :672-686  adds `active_install_id` (:682, STATE:active) and `switches`
 *                                {one_computer, messages_upload} (:683-685, STATE:switches; both false when the
 *                                switch row is absent). `s1 = false` here gives the answer of a server WITHOUT the
 *                                migration (no such keys, cloud_claim_install missing), for the version-skew controls.
 *   _cloud_install_inactive :146-152      true when one_computer AND active_install_id IS DISTINCT FROM the install
 *                                (a NULL active computer refuses too).
 *   writers' gate GATE:active             right after each install_removed gate: {ok:false, error:'computer_not_active'}
 *                                push :170-172, deal :234, parties :302, mark_synced :570, tombstone :604-606 (the
 *                                fake has no message, file or blob functions; P5/P6 add them).
 *   set_my_cloud_autosave :691-758        4 arguments (p_source_install_id DEFAULT NULL); off branch, while the switch is
 *                                on, a computer is active and the caller is licensed: no install -> {success:false,
 *                                error:'install_required'} (:721-723), another install -> {success:false, error:
 *                                'computer_not_active'} (:724-727); a turn-off clears the active computer (:732).
 *   cloud_claim_install :827-869          not_entitled (:838-840); same -> {ok, active} (:841-843); NULL ->
 *                                {ok, active} (:844-848); switch on and not replace -> {ok:false, error:
 *                                'computer_not_active', active_since} (:850-852); switch on and a move in the last
 *                                minute -> {ok:false, error:'busy'} (:853-856); else the move: active = caller, the
 *                                caller's removed-install row deleted when replace (:859-862), a move row only while
 *                                the switch is on (:863-867) -> {ok, active, replaced:<old id>} (:868).
 *   The fake stores no message, file or blob rows, so the erase job's scrub of a non-active computer's emails, texts
 *   and files (P3 condition 6) is not modelled; P5/P6 add those rows.
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
  /** PR-4b: the row's feed number (change_seq). */
  changeSeq?: number;
  purged?: boolean;
  /** PR-4b: set-once fields the pull returns (item: description, is_required, expected_document_type; checklist: template_name, is_private). */
  fields?: Record<string, JsonValue>;
}

export interface FakeEvent {
  owner: string;
  dealId: string;
  seq: number;
  about: string;
  cloudId: string;
  part: string;
  outcome: string;
  loser: JsonValue;
  winner: JsonValue;
  by: string;
  otherBy: string;
  at: number;
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
  /** PR-4b: feed number and soft removal. */
  changeSeq?: number;
  removedKind?: "deal" | "install" | null;
  /** PR-6: what cloud_list_removed returns (property_address; removed_at, restorable_until as ISO). */
  address?: string | null;
  removedAt?: string;
  restorableUntil?: string;
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
export const READ_FUNCTIONS = ["get_my_cloud_autosave_state", "cloud_list_install_rows", "cloud_list_installs", "cloud_todo_pull", "cloud_install_status"];

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
  /**
   * PR-6: cloud_todo_history rows by cloud id, newest first (shape of :1094-1098). A deal restored through
   * cloud_todo_restore or restoreDealOnline gets {outcome restored, actor_kind cloud_user} on top
   * (_cloud_todo_unremove_deal :507).
   */
  history = new Map<string, Array<Record<string, JsonValue>>>();
  /** PR-6: mcp_list_my_connections rows (:951-958). */
  connections: Array<Record<string, JsonValue>> = [];
  /** PR-6: number of history reads (cloud_todo_history calls) answered. */
  historyCalls = 0;
  /** The server's clock for receive times (ms). */
  serverNow = () => Date.parse("2026-11-14T12:00:05.000Z");
  /** PR-4b: the owner's feed head (cloud_todo_feed_head: last_seq, forgotten_through_seq, forgotten_at). */
  feed = new Map<string, { last: number; forgotThrough: number; forgotAt: number }>();
  events: FakeEvent[] = [];
  /** BACKLOG-4263 P2: the server carries migration 20261123100000 (state keys, claim, 4-argument turn-off). */
  s1 = true;
  /** cloud_release_switches.one_computer / messages_upload. */
  oneComputer = false;
  messagesUpload = false;
  /** cloud_autosave_settings.active_install_id / active_since (ISO). */
  activeInstall: string | null = null;
  activeSince: string | null = null;
  /** cloud_computer_moves rows (only while the switch is on). */
  moves: Array<{ from: string | null; to: string; at: number }> = [];

  /** _cloud_install_inactive (:146-152). */
  installInactive(install: unknown): boolean {
    return this.s1 && this.oneComputer && this.activeInstall !== install;
  }

  /** _cloud_todo_take_seq: the owner's next number. */
  nextSeq(owner: string): number {
    const h = this.feed.get(owner) ?? { last: 0, forgotThrough: 0, forgotAt: 0 };
    h.last += 1;
    this.feed.set(owner, h);
    return h.last;
  }

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
    // BACKLOG-4263 P2: a server without migration 20261123100000 has no claim and no 4-argument turn-off (the
    // same PostgREST answer as above, UNOBSERVED).
    if (!this.s1 && (fn === "cloud_claim_install" || (fn === "set_my_cloud_autosave" && "p_source_install_id" in args))) {
      return { data: null, error: { code: "PGRST202", status: 404 }, status: 404 };
    }
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
        ...(this.s1
          ? { active_install_id: this.activeInstall, switches: { one_computer: this.oneComputer, messages_upload: this.messagesUpload } }
          : {}),
        storage: { used_bytes: 0, quota_bytes: null },
      };
    }
    const okKey = fn === "set_my_cloud_autosave" || fn === "cloud_delete_install" ? "success" : "ok";
    if (!uid) return { [okKey]: false, error: fn === "set_my_cloud_autosave" || fn === "cloud_delete_deal" ? "not_authorized" : "not_entitled" };
    if (fn !== "cloud_list_installs" && fn !== "mcp_list_my_connections" && a.p_expected_user_id !== uid) return { [okKey]: false, error: "wrong_account" };
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
        // P2 (:716-728): only the active computer turns off while the switch is on and the caller is licensed.
        if (this.s1 && this.oneComputer && this.activeInstall !== null && this.licensed) {
          if (a.p_source_install_id === undefined || a.p_source_install_id === null) return { success: false, error: "install_required" };
          if (a.p_source_install_id !== this.activeInstall) return { success: false, error: "computer_not_active" };
        }
        this.activeInstall = null;
        this.activeSince = null;
        this.enabled = false;
        this.todos = this.todos.filter((t) => t.owner !== uid);
        for (const k of [...this.todoLedger.keys()]) if (k.startsWith(`${uid}|`)) this.todoLedger.delete(k);
        for (const k of [...this.removedInstalls]) if (k.startsWith(`${uid}|`)) this.removedInstalls.delete(k);
        this.softRemovedDeals = this.softRemovedDeals.filter((d) => d.owner !== uid);
        this.feed.delete(uid);
        this.events = this.events.filter((e) => e.owner !== uid);
        const n = this.deals.filter((d) => d.owner === uid).length;
        this.deals = this.deals.filter((d) => d.owner !== uid);
        this.children = this.children.filter((c) => c.owner !== uid);
        return { success: true, enabled: false, deleted: { deals: n }, blobs_fenced: 0, ai_apps_disconnected: null };
      }
      case "cloud_claim_install": {
        // :832-868
        if (!a.p_source_install_id || typeof a.p_replace !== "boolean") return { ok: false, error: "invalid_input" };
        if (!this.entitled()) return { ok: false, error: "not_entitled" };
        const me = a.p_source_install_id as string;
        const iso = new Date(this.serverNow()).toISOString();
        if (this.activeInstall === me) return { ok: true, active: true };
        if (this.activeInstall === null) {
          this.activeInstall = me;
          this.activeSince = iso;
          return { ok: true, active: true };
        }
        if (this.oneComputer && !a.p_replace) return { ok: false, error: "computer_not_active", active_since: this.activeSince };
        if (this.oneComputer && this.moves.some((m) => m.at > this.serverNow() - 60_000)) return { ok: false, error: "busy" };
        const old = this.activeInstall;
        this.activeInstall = me;
        this.activeSince = iso;
        if (a.p_replace) this.removedInstalls.delete(`${uid}|${me}`);
        if (this.oneComputer) this.moves.push({ from: old, to: me, at: this.serverNow() });
        return { ok: true, active: true, replaced: old };
      }
      case "cloud_upsert_deal": {
        if (!this.entitled()) return { ok: false, error: "not_entitled" };
        const p = a.p_deal as Record<string, JsonValue>;
        if (this.removedInstalls.has(`${uid}|${p.source_install_id}`)) return { ok: false, error: "install_removed" };
        if (this.installInactive(p.source_install_id)) return { ok: false, error: "computer_not_active" };
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
          // F4: the deal and its live checklists and items take new numbers
          soft.removedKind = null;
          soft.changeSeq = this.nextSeq(uid);
          for (const t of this.todos) if (t.dealId === soft.id && !t.removed && !t.purged) t.changeSeq = this.nextSeq(uid);
        }
        if (!d) {
          d = { id: cloudId(), owner: uid, install: p.source_install_id as string, localId: p.local_id as string, hash: "", version: 0, fullSyncAt: null, changeSeq: this.nextSeq(uid) };
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
        // PR-4c (observed Q1b): a deal already removed answers ok again, with no change.
        if (i < 0 && this.softRemovedDeals.some((d) => d.id === a.p_cloud_deal_id && d.owner === uid)) {
          return { ok: true, deleted: { parties: 0, checklists: 0, checklist_items: 0, messages: 0, files: 0 }, blobs_fenced: 0, restorable: true };
        }
        if (i < 0) return { ok: false, error: "not_found" };
        const gone = this.deals.splice(i, 1)[0];
        this.children = this.children.filter((c) => c.dealId !== gone.id);
        gone.removedKind = "deal";
        gone.changeSeq = this.nextSeq(uid);
        this.softRemovedDeals.push(gone);
        return { ok: true, deleted: { parties: 0, checklists: 0, checklist_items: 0, messages: 0, files: 0 }, blobs_fenced: 0 };
      }
      case "cloud_purge_deal_now": {
        // PR-4c (observed Q2a-Q2k, Q4c, Q5c)
        if (!a.p_cloud_deal_id) return { ok: false, error: "invalid_input" };
        if (this.deals.some((d) => d.id === a.p_cloud_deal_id && d.owner === uid)) return { ok: false, error: "not_removed" };
        const soft = this.softRemovedDeals.find((d) => d.id === a.p_cloud_deal_id && d.owner === uid);
        if (!soft) return { ok: true, status: "not_found" };
        this.purgeDealOnline(soft);
        return { ok: true, status: "purged" };
      }
      case "cloud_mark_deal_synced": {
        if (!this.entitled()) return { ok: false, error: "not_entitled" };
        if (this.installInactive(a.p_source_install_id)) return { ok: false, error: "computer_not_active" };
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
        if (this.installInactive(a.p_source_install_id)) return { ok: false, error: "computer_not_active" };
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
        if (this.installInactive(a.p_source_install_id)) return { ok: false, error: "computer_not_active" };
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
                // PR-4b (observed O9c): a soft-removed deal is listed with removed: true
                .concat(this.softRemovedDeals
                  .filter((d) => d.owner === uid && d.install === a.p_source_install_id)
                  .map((d) => ({ cloud_id: d.id, cloud_deal_id: d.id, local_id: d.localId, content_hash: d.hash, removed: true })))
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
        // PR-2: soft removal (kind install), restorable 30 days
        for (const d of gone) {
          d.removedKind = "install";
          d.changeSeq = this.nextSeq(uid);
          this.softRemovedDeals.push(d);
        }
        return { success: true, deleted_deals: gone.length, blobs_fenced: 0, restorable: true };
      }
      case "cloud_install_status":
        if (!a.p_source_install_id) return { ok: false, error: "invalid_input" };
        return { ok: true, removed: this.removedInstalls.has(`${uid}|${a.p_source_install_id}`) };
      case "cloud_reclaim_install": {
        if (!a.p_source_install_id) return { ok: false, error: "invalid_input" };
        // the DELETE is keyed on the caller (auth.uid()), never the argument
        const k = `${uid}|${a.p_source_install_id}`;
        const had = this.removedInstalls.delete(k);
        return { ok: true, removed_entry: had };
      }
      case "cloud_todo_pull":
        return this.todoPull(uid, a);
      // ---- PR-6 (migration 20261118110000; mcp 20261112170000), transcribed from the function bodies
      case "cloud_todo_history": {
        this.historyCalls++;
        if (!["deal", "checklist", "item"].includes(a.p_entity as string) || !a.p_id) return { ok: false, error: "invalid_input" };
        const t = this.todos.find((x) => x.id === a.p_id && x.owner === uid);
        if (t?.purged) return { ok: true, purged: true, rows: [] };
        const lim = Math.min(Math.max(typeof a.p_limit === "number" ? a.p_limit : 20, 1), 50);
        return { ok: true, purged: false, rows: (this.history.get(a.p_id as string) ?? []).slice(0, lim) };
      }
      case "cloud_list_removed": {
        const liveDeal = (id: string) => this.deals.some((d) => d.id === id && d.owner === uid);
        const iso = (ms: number) => new Date(ms).toISOString();
        return {
          ok: true,
          deals: this.softRemovedDeals.filter((d) => d.owner === uid).map((d) => ({
            deal_id: d.id, address: d.address ?? null, removed_at: d.removedAt ?? iso(this.serverNow()),
            removed_kind: d.removedKind ?? "deal", restorable_until: d.restorableUntil ?? iso(this.serverNow() + 30 * 86_400_000),
            source_install_id: d.install,
          })),
          checklists: this.todos.filter((t) => t.owner === uid && t.entity === "checklist" && t.removed && !t.purged && liveDeal(t.dealId)).map((t) => ({
            checklist_id: t.id, deal_id: t.dealId, name: (t.fields?.template_name as string | undefined) ?? null,
            removed_at: (t.parts.removed.value as Record<string, JsonValue>)?.removed_at ?? null,
          })),
          items: this.todos.filter((t) => {
            if (t.owner !== uid || t.entity !== "item" || !t.removed || t.purged || !liveDeal(t.dealId)) return false;
            const list = this.todos.find((x) => x.id === t.checklistId);
            return !list?.removed;
          }).map((t) => ({
            item_id: t.id, deal_id: t.dealId, checklist_id: t.checklistId, title: t.parts.title.value,
            removed_at: (t.parts.removed.value as Record<string, JsonValue>)?.removed_at ?? null,
          })),
        };
      }
      case "cloud_todo_restore": {
        const ent = a.p_entity as string;
        if (!["deal", "checklist", "item"].includes(ent) || !a.p_id) return { ok: false, error: "invalid_input" };
        if (ent === "deal") {
          const soft = this.softRemovedDeals.find((d) => d.id === a.p_id && d.owner === uid);
          if (!soft) {
            const live = this.deals.some((d) => d.id === a.p_id && d.owner === uid);
            return { ok: true, results: [{ status: live ? "not_removed" : "not_found", cloud_id: a.p_id }] };
          }
          this.restoreDealOnline(soft);
          return { ok: true, results: [{ status: "restored", cloud_id: a.p_id, renumbered: 1 }] };
        }
        const t = this.todos.find((x) => x.id === a.p_id && x.owner === uid && x.entity === ent);
        if (!t || t.purged) return { ok: true, results: [{ op_id: a.p_op_id, status: "not_found", entity: ent, cloud_id: a.p_id }] };
        if (!t.removed) return { ok: true, results: [{ op_id: a.p_op_id, status: "not_removed", entity: ent, cloud_id: a.p_id }] };
        this.restoreOnline(t);
        return { ok: true, results: [{ op_id: a.p_op_id, status: "restored", entity: ent, cloud_id: a.p_id }] };
      }
      case "mcp_list_my_connections":
        return { ok: true, connections: this.connections };
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
      t.changeSeq = this.nextSeq(t.owner);
    };
    // PR-4b: a conflict event with its own number (migration :860-869)
    const event = (outcome: string, loser: JsonValue, winner: JsonValue) =>
      this.events.push({ owner: t.owner, dealId: t.dealId, seq: this.nextSeq(t.owner), about: t.entity, cloudId: t.id, part, outcome, loser, winner, by, otherBy: cur.by, at: eff });
    if (base === cur.rev || (cur.by === by && es !== null && es > (cur.edit_seq ?? -1))) {
      write();
      return { status: onRemoved ? "applied_to_removed" : "applied", conflict: false };
    }
    const curKind = cur.by.split(":")[0];
    const kind = by.split(":")[0];
    const wins = eff > cur.at || (eff === cur.at && kind > curKind);
    if (wins) {
      const old = cur.value;
      write();
      event(onRemoved ? "applied_to_removed" : "applied", old, value);
      return { status: onRemoved ? "applied_to_removed" : "applied", conflict: true };
    }
    event("lost", value, cur.value);
    return { status: "lost", conflict: true };
  }

  private todoPush(uid: string, a: Record<string, JsonValue>): unknown {
    if (!this.entitled()) return { ok: false, error: "not_entitled" };
    const install = a.p_source_install_id as string;
    if (!install) return { ok: false, error: "invalid_input" };
    if (this.removedInstalls.has(`${uid}|${install}`)) return { ok: false, error: "install_removed" };
    if (this.installInactive(install)) return { ok: false, error: "computer_not_active" };
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
          templateId: op.template_id as string, removed: false, changeSeq: this.nextSeq(uid),
          fields: { template_name: (op.template_name ?? null) as JsonValue, is_private: op.is_private === true },
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
        changeSeq: this.nextSeq(uid),
        fields: { description: (op.description ?? null) as JsonValue, is_required: op.is_required === true, expected_document_type: (op.expected_document_type ?? null) as JsonValue, local_created_at: (op.local_created_at ?? null) as JsonValue },
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
    // migration :740-753: by cloud id when the op names one (then local_id is ignored), else by deal + local id / alias
    const t = dl
      ? this.todos.find((x) =>
          x.entity === ent && x.dealId === dl.deal.id &&
          (typeof op.id === "string" ? x.id === op.id : x.localId === op.local_id || (x.aliases ?? []).includes(op.local_id as string)))
      : undefined;
    if (!dl || !t) return { op_id: opId, status: "not_found" };
    if (t.purged) return { op_id: opId, status: "not_restorable", entity: ent, cloud_id: t.id };
    const parent = t.checklistId ? this.todos.find((x) => x.id === t.checklistId) : undefined;
    const onRemoved = t.removed || dl.removed || !!parent?.removed;
    if (kind === "remove") {
      // contract my_items.list_removal: a My items list goes only with its deal, for every actor
      if (ent === "checklist" && t.templateId === "keepr:my-items") return { op_id: opId, status: "not_allowed", entity: ent, cloud_id: t.id };
      if (t.removed) return this.todoAnswer(opId, "already_removed", t);
      const cur = t.parts.removed;
      t.parts.removed = { rev: cur.rev + 1, value: { removed_at: new Date(recv).toISOString(), kind: ent }, at: Math.max(cur.at, eff), by, edit_seq: es };
      t.removed = true;
      t.changeSeq = this.nextSeq(uid);
      return this.todoAnswer(opId, "removed", t);
    }
    if (kind !== "set") return { op_id: opId, status: "rejected", reason: "invalid_value", field: "kind" };
    const part = op.part as string;
    if (!(part in t.parts) || part === "removed") return { op_id: opId, status: "rejected", reason: "invalid_value", field: "part" };
    const r = this.mergePart(t, part, (op.value ?? null) as JsonValue, op, by, eff, onRemoved);
    return this.todoAnswer(opId, r.status, t, r.conflict);
  }

  // ------------------------------------------------------------ cloud_todo_pull (BACKLOG-4263 PR-4b, see header)

  private feedRow(t: FakeTodo): Record<string, JsonValue> {
    const base: Record<string, JsonValue> =
      t.entity === "item"
        ? { entity: "item", cloud_id: t.id, cloud_deal_id: t.dealId, cloud_checklist_id: t.checklistId, local_id: t.localId, change_seq: t.changeSeq ?? 0, purged: !!t.purged }
        : { entity: "checklist", cloud_id: t.id, cloud_deal_id: t.dealId, local_id: t.localId, change_seq: t.changeSeq ?? 0, purged: !!t.purged, template_id: t.templateId };
    if (t.purged) return base;
    const f = t.fields ?? {};
    const extra: Record<string, JsonValue> =
      t.entity === "item"
        ? { description: f.description ?? null, is_required: f.is_required ?? false, expected_document_type: f.expected_document_type ?? null, local_created_at: f.local_created_at ?? null, created_by: "desktop:", created_at: "2026-11-14T10:00:00.000Z" }
        : { template_name: f.template_name ?? null, is_private: f.is_private ?? false, created_by: "desktop:" };
    return { ...base, ...extra, parts: this.todoJson(t) };
  }

  private todoPull(uid: string, a: Record<string, JsonValue>): unknown {
    if (!this.entitled()) return { ok: false, error: "not_entitled" };
    const install = a.p_source_install_id as string;
    if (!install) return { ok: false, error: "invalid_input" };
    const after = Math.max(typeof a.p_after_seq === "number" ? a.p_after_seq : 0, 0);
    const horizon = typeof a.p_horizon === "number" ? a.p_horizon : null;
    if (after > 0 && horizon === null) return { ok: false, error: "horizon_required" };
    const lim = Math.min(Math.max(typeof a.p_limit === "number" ? a.p_limit : 500, 1), 500);
    const h = this.feed.get(uid) ?? { last: 0, forgotThrough: 0, forgotAt: 0 };
    const deals = [...this.deals, ...this.softRemovedDeals].filter((d) => d.owner === uid && d.install === install);
    const dealIds = new Set(deals.map((d) => d.id));
    const all: Array<{ seq: number; j: JsonValue }> = [];
    for (const d of deals) {
      const removed = this.softRemovedDeals.includes(d);
      all.push({ seq: d.changeSeq ?? 0, j: { entity: "deal", cloud_id: d.id, local_id: d.localId, change_seq: d.changeSeq ?? 0,
        removed_at: removed ? "2026-11-14T11:00:00.000Z" : null, removed_kind: removed ? (d.removedKind ?? "deal") : null,
        restorable_until: removed ? "2026-12-14T11:00:00.000Z" : null } });
    }
    for (const t of this.todos) if (t.owner === uid && dealIds.has(t.dealId)) all.push({ seq: t.changeSeq ?? 0, j: this.feedRow(t) });
    for (const e of this.events) {
      if (e.owner !== uid || !dealIds.has(e.dealId)) continue;
      all.push({ seq: e.seq, j: { entity: "event", change_seq: e.seq, cloud_deal_id: e.dealId, about: e.about, cloud_id: e.cloudId, part: e.part,
        outcome: e.outcome, loser_value: e.loser, winner_value: e.winner, by: e.by, label: e.by.startsWith("ai_app") ? "Claude" : "Keepr desktop",
        other_by: e.otherBy, effective_at: Number.isFinite(e.at) ? new Date(e.at).toISOString() : "-infinity", received_at: new Date(this.serverNow()).toISOString() } });
    }
    const page = all.filter((x) => x.seq > after && x.seq <= h.last).sort((x, y) => x.seq - y.seq).slice(0, lim);
    const by = `desktop:${install}`;
    let max: number | null = null;
    for (const t of this.todos) {
      if (t.owner !== uid || t.purged) continue;
      for (const p of Object.values(t.parts)) if (p.by === by && p.edit_seq !== null) max = Math.max(max ?? p.edit_seq, p.edit_seq);
    }
    return {
      ok: true,
      head: h.last,
      rows: page.map((x) => x.j),
      horizon: h.forgotAt,
      next_after: page.length === lim ? page[page.length - 1].seq : Math.max(h.last, after),
      install_max_edit_seq: max,
      resync_required: after > h.last || (after > 0 && h.forgotAt > (horizon as number) && h.forgotThrough > after),
    };
  }

  // ------------------------------------------------------------ test helpers: another side's change through the core

  /** An AI-app `set` (the core fills the base from the current row, so it is causal): the merge of :793-858. */
  aiSet(t: FakeTodo, part: string, value: JsonValue, atMs: number = this.serverNow(), ref = "conn-1"): string {
    if (t.removed) return "refused_removed";
    const cur = t.parts[part];
    if ((part === "done" ? !!(cur.value as Record<string, JsonValue>)?.is_checked === !!(value as Record<string, JsonValue>)?.is_checked : JSON.stringify(cur.value) === JSON.stringify(value))) return "unchanged";
    t.parts[part] = { rev: cur.rev + 1, value, at: Math.max(cur.at, atMs), by: `ai_app:${ref}`, edit_seq: null };
    t.changeSeq = this.nextSeq(t.owner);
    return "applied";
  }

  /**
   * An AI-app add to a checklist (local_item_id = the new id, :690-720). sort_order: what mcp_add_todo sends
   * (migration 20261118130000, _mcp_todo_call ADD:order): the next free place on the live list, max + 1 over its live
   * items, 0 for an empty list. Observed on the real functions (harness-5.sql c_order): live My items 0, 1, 2 and a
   * removed one at 3 -> 3; a new list -> 0. Pass null for a create without sort_order (the core's own default).
   * The SQL takes the max over the deal's live My items lists; the server keeps at most one live list per deal
   * (partial unique index, migration 20261118110000), so that is this one list.
   */
  aiAdd(checklist: FakeTodo, title: string, atMs: number = this.serverNow(), sortOrder?: number | null): FakeTodo {
    const live = this.todos.filter((x) => x.entity === "item" && x.checklistId === checklist.id && !x.removed).map((x) => x.parts.order.value);
    const order = sortOrder !== undefined ? sortOrder : live.length === 0 ? 0 : Math.max(...live.map((v) => (typeof v === "number" ? v : -1))) + 1;
    const id = cloudId();
    const by = "ai_app:conn-1";
    const t: FakeTodo = {
      id, owner: checklist.owner, dealId: checklist.dealId, entity: "item", localId: id, checklistId: checklist.id, templateId: null, removed: false,
      changeSeq: this.nextSeq(checklist.owner),
      fields: { description: null, is_required: false, expected_document_type: null, local_created_at: null },
      parts: {
        done: { rev: 1, value: { is_checked: false, checked_at: null }, at: atMs, by, edit_seq: null },
        title: { rev: 1, value: title, at: atMs, by, edit_seq: null },
        note: { rev: 1, value: null, at: atMs, by, edit_seq: null },
        due: { rev: 1, value: null, at: atMs, by, edit_seq: null },
        // migration :638 / _cloud_todo_norm :407 store the op's sort_order (NULL when none is sent)
        order: { rev: 1, value: order, at: atMs, by, edit_seq: null },
        removed: { rev: 1, value: { removed_at: null, kind: null }, at: atMs, by, edit_seq: null },
      },
    };
    this.todos.push(t);
    return t;
  }

  /** A removal by another side (AI app or the owner online). */
  removeOnline(t: FakeTodo, by = "ai_app:conn-1"): void {
    const cur = t.parts.removed;
    t.parts.removed = { rev: cur.rev + 1, value: { removed_at: new Date(this.serverNow()).toISOString(), kind: t.entity }, at: this.serverNow(), by, edit_seq: null };
    t.removed = true;
    t.changeSeq = this.nextSeq(t.owner);
  }

  /** cloud_todo_restore of an item or checklist (a checklist's items are NOT renumbered: observed O5f). */
  restoreOnline(t: FakeTodo, by = "cloud_user:owner"): void {
    const cur = t.parts.removed;
    t.parts.removed = { rev: cur.rev + 1, value: { removed_at: null, kind: null }, at: this.serverNow(), by, edit_seq: null };
    t.removed = false;
    t.changeSeq = this.nextSeq(t.owner);
  }

  /**
   * PR-4c: _cloud_todo_purge_deal :1227-1259 (shared by cloud_purge_deal_now and the daily purge of a deal past its
   * 30 days): the removed deal, its todos and their events go; forgotten_through_seq rises to the highest number
   * deleted and forgotten_at takes a new number (observed Q2h, Q2k).
   */
  purgeDealOnline(d: FakeDeal): void {
    const seqs = [d.changeSeq ?? 0, ...this.todos.filter((t) => t.dealId === d.id).map((t) => t.changeSeq ?? 0), ...this.events.filter((e) => e.dealId === d.id).map((e) => e.seq)];
    this.softRemovedDeals = this.softRemovedDeals.filter((x) => x !== d);
    this.todos = this.todos.filter((t) => t.dealId !== d.id);
    this.events = this.events.filter((e) => e.dealId !== d.id);
    const mark = this.nextSeq(d.owner);
    const h = this.feed.get(d.owner) as { last: number; forgotThrough: number; forgotAt: number };
    h.forgotThrough = Math.max(h.forgotThrough, ...seqs);
    h.forgotAt = mark;
  }

  /** PR-4c: cloud_todo_restore of a removed deal by another side (:1108-1158, F4 at _cloud_todo_unremove_deal; Q5). */
  restoreDealOnline(d: FakeDeal): void {
    this.history.set(d.id, [{ kind: "change", part: "removed", outcome: "restored", actor_kind: "cloud_user", actor_label: "Keepr" }, ...(this.history.get(d.id) ?? [])]);
    this.softRemovedDeals = this.softRemovedDeals.filter((x) => x !== d);
    this.deals.push(d);
    d.removedKind = null;
    d.changeSeq = this.nextSeq(d.owner);
    for (const t of this.todos) if (t.dealId === d.id && !t.removed && !t.purged) t.changeSeq = this.nextSeq(d.owner);
  }

  /** The daily purge of one removed todo (observed O8): no content, a new number, the forgotten markers move. */
  purgeOnline(t: FakeTodo): void {
    const h = this.feed.get(t.owner) ?? { last: 0, forgotThrough: 0, forgotAt: 0 };
    h.forgotThrough = Math.max(h.forgotThrough, t.changeSeq ?? 0);
    this.feed.set(t.owner, h);
    t.purged = true;
    t.changeSeq = this.nextSeq(t.owner);
    this.feed.get(t.owner)!.forgotAt = this.nextSeq(t.owner);
  }
}
