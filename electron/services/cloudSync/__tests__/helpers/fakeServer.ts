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
}

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
  calls: Array<{ fn: string; args: Record<string, JsonValue> }> = [];
  override: Override | null = null;

  constructor(user: string) {
    this.tokenUser = user;
  }

  callsTo(fn: string) {
    return this.calls.filter((c) => c.fn === fn);
  }

  writeCalls() {
    return this.calls.filter((c) => c.fn !== "get_my_cloud_autosave_state");
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
    const okKey = fn === "set_my_cloud_autosave" ? "success" : "ok";
    if (!uid) return { [okKey]: false, error: fn === "set_my_cloud_autosave" || fn === "cloud_delete_deal" ? "not_authorized" : "not_entitled" };
    if (a.p_expected_user_id !== uid) return { [okKey]: false, error: "wrong_account" };
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
        this.deals.splice(i, 1);
        return { ok: true, deleted: { parties: 0, checklists: 0, checklist_items: 0, messages: 0, files: 0 }, blobs_fenced: 0 };
      }
      case "cloud_mark_deal_synced": {
        if (!this.entitled()) return { ok: false, error: "not_entitled" };
        const d = this.deals.find((x) => x.id === a.p_cloud_deal_id && x.owner === uid && x.install === a.p_source_install_id);
        if (!d) return { ok: false, error: "not_found" };
        d.fullSyncAt = "2026-11-14T10:00:01.000Z";
        return { ok: true, last_full_sync_at: d.fullSyncAt };
      }
      default:
        throw new Error(`unexpected rpc ${fn}`);
    }
  }
}
