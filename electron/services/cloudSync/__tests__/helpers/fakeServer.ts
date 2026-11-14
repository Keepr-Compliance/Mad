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
 */
import type { RpcTransport, RpcResponse } from "../../cloudClient";
import type { JsonValue } from "../../jcs";

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
        return { ok: true, deleted: { parties: 0, checklists: 0, checklist_items: 0, messages: 0, files: 0 }, blobs_fenced: 0 };
      }
      case "cloud_mark_deal_synced": {
        if (!this.entitled()) return { ok: false, error: "not_entitled" };
        const d = this.deals.find((x) => x.id === a.p_cloud_deal_id && x.owner === uid && x.install === a.p_source_install_id);
        if (!d) return { ok: false, error: "not_found" };
        d.fullSyncAt = "2026-11-14T10:00:01.000Z";
        return { ok: true, last_full_sync_at: d.fullSyncAt };
      }
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
        const gone = this.deals.filter((d) => d.owner === uid && d.install === a.p_source_install_id);
        this.deals = this.deals.filter((d) => !gone.includes(d));
        this.children = this.children.filter((c) => !gone.some((d) => d.id === c.dealId));
        return { success: true, deleted_deals: gone.length, blobs_fenced: 0 };
      }
      default:
        throw new Error(`unexpected rpc ${fn}`);
    }
  }
}
