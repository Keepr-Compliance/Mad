/**
 * The todo screens' main side — BACKLOG-4263 PR-6.
 *
 * Everything the Checklist tab and Settings › Keepr Cloud › Removed ask about Keepr Cloud todos and removed
 * deals that the pass engine does not already answer. Main decides everything: the renderer sends ids, main
 * reads them again (a restore names only something main itself lists for this user and this deal).
 *
 * Writes:
 * - a todo restore is the server's `cloud_todo_restore` as the owner (actor `cloud_user`); the restored todo
 *   comes back through the ordinary pull (`kick`), in its page transaction. Refused on a deal locked here.
 * - an online-only deal restore is `cloud_todo_restore('deal')`; nothing local is written.
 * - dismissing a notice is one UPDATE of this user's own notice.
 * Nothing here writes a todo, a shadow, `changed_json` or an outbox row.
 *
 * Invisible to a user who never turned Keepr Cloud on: every method answers "off" (or nothing) unless
 * `cloud_sync_settings.enabled = 1` for the signed-in user, read locally.
 */
import { randomUUID } from "crypto";
import type { CloudClient } from "./cloudClient";
import type { SqlDb } from "../db/cloudSyncSqlDb";
import * as screens from "../db/cloudSyncTodoScreensDb";
import { dealLockedHere } from "../db/cloudSyncTodoPullDb";
import type {
  CloudTodoHistoryResult,
  CloudTodoHistoryRow,
  CloudTodoMarker,
  CloudTodoNotice,
  CloudTodoRemovedResult,
  CloudTodoResult,
  CloudTodosForDeal,
  CloudSyncRemovedOnlineDeal,
} from "../../types/ipc/window-api-cloud-todos";

export interface TodoScreensDeps {
  db: () => SqlDb;
  dbReady: () => boolean;
  client: CloudClient;
  projectRef: string | null;
  /** The validated session user the SDK agrees with, or null (cloudSyncService.sessionUser). For actions. */
  sessionUser: () => Promise<string | null>;
  /**
   * This computer's signed-in user from the local session only (cloudSyncService.localSessionUser). For the read-only
   * answers that must follow the archive's rule (`enabled = 1` for the user), also while the SDK disagrees.
   */
  localSessionUser: () => Promise<string | null>;
  isOnline: () => boolean;
  /** This computer's install id, or null (cloudSyncDbService.currentInstallId). */
  installId: () => string | null;
  /** Deals this user deleted here and can restore here (the local Removed list), by transaction id. */
  archivedDealIds: () => Promise<Set<string>>;
  /** This install's online deals, cloud id -> local id (cloudSyncService.onlineDealLocalIds), or null. */
  onlineDealLocalIds: () => Promise<Map<string, string> | null>;
  /** Runs a pass now (the pull brings a restored todo back). */
  kick: () => Promise<unknown>;
  now?: () => Date;
}

const HISTORY_LIMIT = 20;
/** Rows asked for: the list shows at most 20 after the filter; the server allows at most 50. */
const HISTORY_FETCH = 50;
const PART_KEYS = new Set(["done", "title", "note", "due", "order", "removed", "create"]);

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parse(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A history row's actor in the user's words (the row carries no ref: see history()). */
export function historyWho(kind: string | null, label: string | null): string {
  if (kind === "ai_app") return label && label.length > 0 && label.length <= 60 ? label : "an AI app";
  if (kind === "desktop") return "You, on a computer";
  if (kind === "cloud_user") return "You";
  return "another device";
}

/** A finite timestamp as ISO, or null ('-infinity' is an unknowable clock, :997-999). */
export function whenOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A part value as plain text for a screen (never raw JSON). */
export function partText(part: string | null, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (part === "done") {
    const o = value as { is_checked?: unknown };
    return o && typeof o === "object" ? (o.is_checked === true ? "ticked" : "not ticked") : null;
  }
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

export class CloudTodoScreens {
  /** connection id -> provider name, read once per session user while online (mcp_list_my_connections). */
  private labels: { user: string; map: Map<string, string> } | null = null;

  constructor(private readonly deps: TodoScreensDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** The signed-in user when Keepr Cloud is on for them here; otherwise null. `local`: the local session only (reads). */
  private async onUser(local = false): Promise<string | null> {
    const ref = this.deps.projectRef;
    if (!ref || !this.deps.dbReady()) return null;
    const user = local ? await this.deps.localSessionUser() : await this.deps.sessionUser();
    if (!user) return null;
    return screens.cloudOnForUser(this.deps.db(), ref, user) ? user : null;
  }

  /** Local only: whether Keepr Cloud is on for the signed-in user, and whether this computer is online. */
  async localState(): Promise<{ on: boolean; online: boolean }> {
    const user = await this.onUser(true);
    return { on: user !== null, online: this.deps.isOnline() };
  }

  /** The provider name of an AI-app connection, when this user's connection list (online) names it. */
  private async appNames(user: string): Promise<Map<string, string>> {
    if (this.labels?.user === user) return this.labels.map;
    const map = new Map<string, string>();
    if (!this.deps.isOnline()) return map;
    const res = await this.deps.client.listMyAiConnections();
    if (res.kind === "ok" && Array.isArray(res.body.connections)) {
      for (const c of res.body.connections as Array<Record<string, unknown>>) {
        const id = str(c?.id);
        const provider = str(c?.provider);
        if (id && provider) map.set(id, PROVIDER_NAMES[provider] ?? "an AI app");
      }
      this.labels = { user, map };
    }
    return map;
  }

  /** Who a `kind:ref` actor is, in the user's words. */
  private who(by: string | null, label: string | null, names: Map<string, string>): string {
    if (!by) return "another device";
    const [kind, ref = ""] = by.split(":", 2);
    if (kind === "ai_app") return names.get(ref) ?? (label && label.length <= 60 ? label : null) ?? "an AI app";
    if (kind === "desktop") return ref === this.deps.installId() ? "this computer" : "another computer";
    if (kind === "cloud_user") return "You";
    return "another device";
  }

  /** One deal's notices and AI-app markers. Empty when Keepr Cloud is off or the deal is not this user's. */
  async forDeal(transactionId: string): Promise<CloudTodosForDeal> {
    const online = this.deps.isOnline();
    const user = await this.onUser(true);
    const db = this.deps.db();
    const ref = this.deps.projectRef as string;
    if (!user || !screens.dealOwnedBy(db, transactionId, user)) return { on: false, online, notices: [], markers: {} };
    const rows = screens.noticesForDeal(db, ref, user, transactionId);
    const markerRows = screens.markersForDeal(db, ref, user, transactionId);
    const needNames = markerRows.length > 0 || rows.some((r) => r.kind === "conflict");
    const names = needNames ? await this.appNames(user) : new Map<string, string>();

    const notices: CloudTodoNotice[] = [];
    for (const r of rows) {
      const itemId = screens.resolveNoticeItem(db, ref, user, r.entity, r.local_id);
      const other = parse(r.other_json);
      const local = r.entity === "item" && itemId ? screens.itemValues(db, itemId) : null;
      const title = str(local?.title) ?? str((other?.title as unknown) ?? null);
      if (r.kind === "conflict") {
        if (!itemId || !local || r.entity !== "item") continue;
        const part = r.part;
        if (!part || !["done", "title", "note", "due"].includes(part)) continue;
        const current = partText(part, part === "done" ? { is_checked: local.is_checked === 1 } : part === "due" ? local.due_date : local[part]);
        const loser = partText(part, other?.loser_value);
        const winner = partText(part, other?.winner_value);
        // the other version is whichever of the two this computer does not show now
        const otherText = loser !== current ? loser : winner !== current ? winner : null;
        if (otherText === current) continue;
        const otherValue = loser !== current ? other?.loser_value : other?.winner_value;
        const mine = `desktop:${this.deps.installId() ?? ""}`;
        const by = str(other?.by);
        const otherBy = str(other?.other_by);
        const side = by === mine ? otherBy : by;
        notices.push({
          id: r.id,
          kind: "conflict",
          itemId,
          title,
          part: part as CloudTodoNotice["part"],
          otherText,
          otherValue: (otherValue ?? null) as CloudTodoNotice["otherValue"],
          who: this.who(side, side === by ? r.actor_label : null, names),
        });
        continue;
      }
      if (!["dropped_not_online", "local_write_failed", "links_not_restored", "rejected", "not_allowed", "not_restorable"].includes(r.kind)) continue;
      const count = typeof other?.count === "number" ? (other.count as number) : null;
      notices.push({
        id: r.id,
        kind: r.kind === "rejected" || r.kind === "not_allowed" || r.kind === "not_restorable" ? "not_accepted" : (r.kind as CloudTodoNotice["kind"]),
        itemId,
        title,
        part: null,
        otherText: null,
        otherValue: null,
        who: null,
        count,
      });
    }

    const markers: Record<string, CloudTodoMarker> = {};
    // A part this computer changed and has not sent yet is this computer's change now: no AI-app marker for it
    // until the answer (a kept change clears the marker; a lost one keeps it).
    const waiting = markerRows.length > 0 ? screens.waitingItemParts(db, ref, user, transactionId) : new Set<string>();
    for (const m of markerRows) {
      const j = parse(m.changed_json);
      const part = str(j?.part);
      const by = str(j?.by);
      const at = str(j?.at);
      if (!part || !PART_KEYS.has(part) || !by || !at) continue;
      if (part !== "create" && waiting.has(`${m.local_id}|${part}`)) continue;
      const local = screens.itemValues(db, m.local_id);
      if (!local) continue;
      markers[m.local_id] = {
        kind: part === "create" ? "added" : part === "done" ? (local.is_checked === 1 ? "ticked" : "unticked") : "changed",
        who: this.who(by, null, names),
        at,
      };
    }
    return { on: true, online, notices, markers };
  }

  async dismissNotice(id: number): Promise<CloudTodoResult> {
    const user = await this.onUser();
    if (!user) return { success: false, error: "cloud_off" };
    return screens.dismissTodoNotice(this.deps.db(), this.deps.projectRef as string, user, id, this.now())
      ? { success: true }
      : { success: false, error: "not_found" };
  }

  /** The last 20 changes of one item, online only. */
  async history(itemId: string): Promise<CloudTodoHistoryResult> {
    const user = await this.onUser();
    if (!user) return { success: false, error: "cloud_off", rows: [] };
    const db = this.deps.db();
    const tx = screens.dealOfItem(db, itemId);
    if (!tx || !screens.dealOwnedBy(db, tx, user)) return { success: false, error: "not_found", rows: [] };
    if (!this.deps.isOnline()) return { success: false, error: "offline", rows: [] };
    const cloudId = screens.cloudIdOf(db, this.deps.projectRef as string, user, "item", itemId);
    if (!cloudId) return { success: true, rows: [] };
    const res = await this.deps.client.todoHistory(user, "item", cloudId, HISTORY_FETCH);
    if (res.kind === "transport") return { success: false, error: "offline", rows: [] };
    if (res.kind !== "ok" || !Array.isArray(res.body.rows)) return { success: false, error: "unavailable", rows: [] };
    // What cloud_todo_history returns (migration 20261118110000 :1094-1098; observed on the test database,
    // supabase/tests/backlog-4263-pr6/harness-6-history.sql): kind, part, old_value, new_value, outcome, actor_kind,
    // actor_label, other_by, effective_at, received_at, change_seq. NO actor_ref, and a desktop row's label is
    // "Keepr" for every computer, so this computer cannot be told from another one here.
    // Shown: kind 'change' only (a concurrent edit also writes a 'conflict' row, with old and new swapped when
    // it lost, :860-869); not 'unchanged' (:835) and not the order part.
    const rows: CloudTodoHistoryRow[] = [];
    for (const h of res.body.rows as Array<Record<string, unknown>>) {
      if (rows.length >= HISTORY_LIMIT) break;
      if (h.kind !== "change" || h.outcome === "unchanged") continue;
      const part = str(h.part);
      if (!part || part === "order") continue;
      const what: CloudTodoHistoryRow["what"] =
        part === "created" ? "added" : part === "removed" ? (h.outcome === "restored" ? "restored" : "removed") : "changed";
      rows.push({
        who: historyWho(str(h.actor_kind), str(h.actor_label)),
        at: whenOf(h.effective_at) ?? whenOf(h.received_at),
        what,
        part: what === "changed" ? part : null,
        oldText: what === "changed" ? partText(part, h.old_value) : null,
        newText: what === "changed" ? partText(part, h.new_value) : null,
        kept: h.outcome !== "lost",
      });
    }
    return { success: true, rows };
  }

  /** Todos and checklists of one deal removed online in the last 30 days (online only). */
  async listRemovedTodos(transactionId: string): Promise<CloudTodoRemovedResult> {
    const user = await this.onUser();
    if (!user) return { success: false, error: "cloud_off", items: [] };
    const db = this.deps.db();
    if (!screens.dealOwnedBy(db, transactionId, user)) return { success: false, error: "not_found", items: [] };
    if (!this.deps.isOnline()) return { success: false, error: "offline", items: [] };
    const dealCloudId = screens.cloudDealIdOf(db, this.deps.projectRef as string, user, transactionId);
    if (!dealCloudId) return { success: true, items: [] };
    const res = await this.deps.client.listRemoved(user);
    if (res.kind === "transport") return { success: false, error: "offline", items: [] };
    if (res.kind !== "ok") return { success: false, error: "unavailable", items: [] };
    const items: CloudTodoRemovedResult["items"] = [];
    for (const c of (Array.isArray(res.body.checklists) ? res.body.checklists : []) as Array<Record<string, unknown>>) {
      if (c?.deal_id !== dealCloudId || !str(c.checklist_id)) continue;
      items.push({ entity: "checklist", cloudId: str(c.checklist_id) as string, title: str(c.name) ?? "Checklist", removedAt: str(c.removed_at) });
    }
    for (const t of (Array.isArray(res.body.items) ? res.body.items : []) as Array<Record<string, unknown>>) {
      if (t?.deal_id !== dealCloudId || !str(t.item_id)) continue;
      items.push({ entity: "item", cloudId: str(t.item_id) as string, title: str(t.title) ?? "", removedAt: str(t.removed_at) });
    }
    return { success: true, items };
  }

  /** Restores one of them through the server, then pulls. Only what listRemovedTodos lists for this deal. */
  async restoreTodo(transactionId: string, entity: "item" | "checklist", cloudId: string): Promise<CloudTodoResult> {
    const user = await this.onUser();
    if (!user) return { success: false, error: "cloud_off" };
    const db = this.deps.db();
    if (!screens.dealOwnedBy(db, transactionId, user)) return { success: false, error: "not_found" };
    if (dealLockedHere(db, transactionId)) return { success: false, error: "locked" };
    if (!this.deps.isOnline()) return { success: false, error: "offline" };
    const listed = await this.listRemovedTodos(transactionId);
    if (!listed.success) return { success: false, error: listed.error };
    if (!listed.items.some((i) => i.entity === entity && i.cloudId === cloudId)) return { success: false, error: "not_found" };
    const res = await this.deps.client.todoRestore(user, entity, cloudId, randomUUID());
    if (res.kind === "transport") return { success: false, error: "offline" };
    if (res.kind !== "ok") return { success: false, error: "unavailable" };
    const status = str(((res.body.results as Array<Record<string, unknown>> | undefined) ?? [])[0]?.status);
    if (status !== "restored" && status !== "not_removed") return { success: false, error: status === "locked" ? "locked" : "not_restorable" };
    await this.deps.kick();
    return { success: true };
  }

  /**
   * Deals removed online in the last 30 days that this computer cannot restore from its own archive:
   * - `online`: not on this computer (deleted by an older Keepr, or on another computer): Restore makes the
   *   online copy live again ("Online only");
   * - `rejected`: still here but marked Rejected, so it is not saved online.
   * A deal still here and not rejected comes back by itself and is not listed; one removed with this computer's
   * whole copy is the "save this computer's deals again" line instead.
   */
  async listRemovedOnline(): Promise<{ success: boolean; error?: string; deals: CloudSyncRemovedOnlineDeal[] }> {
    const user = await this.onUser();
    if (!user) return { success: false, error: "cloud_off", deals: [] };
    if (!this.deps.isOnline()) return { success: false, error: "offline", deals: [] };
    const res = await this.deps.client.listRemoved(user);
    if (res.kind === "transport") return { success: false, error: "offline", deals: [] };
    if (res.kind !== "ok") return { success: false, error: "unavailable", deals: [] };
    const db = this.deps.db();
    const mine = this.deps.installId();
    const archived = await this.deps.archivedDealIds();
    let localIds: Map<string, string> | null | undefined;
    const nowMs = this.now().getTime();
    const deals: CloudSyncRemovedOnlineDeal[] = [];
    for (const d of (Array.isArray(res.body.deals) ? res.body.deals : []) as Array<Record<string, unknown>>) {
      const cloudId = str(d?.deal_id);
      if (!cloudId) continue;
      const until = str(d.restorable_until);
      if (until && Date.parse(until) <= nowMs) continue;
      const fromHere = str(d.source_install_id) === mine;
      // A deal removed with its whole computer's copy: from this computer, "save this computer's deals again"
      // covers it; from another computer, it went with "Delete them" for that computer's copy, and the server
      // would restore every deal of that copy on one click. Neither is listed here.
      if (d.removed_kind === "install") continue;
      let localId = fromHere ? screens.localDealIdOf(db, this.deps.projectRef as string, user, cloudId) : null;
      if (fromHere && !localId) {
        if (localIds === undefined) localIds = await this.deps.onlineDealLocalIds();
        // unreadable: never offer a restore for a deal that may still be on this computer
        if (localIds === null) continue;
        localId = localIds.get(cloudId) ?? null;
      }
      if (localId && archived.has(localId)) continue;
      const state = localId ? screens.localDealState(db, localId, user) : "absent";
      if (state === "present") continue;
      deals.push({
        cloudId,
        propertyAddress: str(d.address),
        removedAt: str(d.removed_at),
        restorableUntil: until,
        kind: state === "rejected" ? "rejected" : "online",
      });
    }
    return { success: true, deals };
  }

  /** Makes a deal removed online live again online ("Online only"). Only a deal listRemovedOnline lists as `online`. */
  async restoreOnlineDeal(cloudId: string): Promise<CloudTodoResult> {
    const user = await this.onUser();
    if (!user) return { success: false, error: "cloud_off" };
    const listed = await this.listRemovedOnline();
    if (!listed.success) return { success: false, error: listed.error };
    if (!listed.deals.some((d) => d.cloudId === cloudId && d.kind === "online")) return { success: false, error: "not_found" };
    const res = await this.deps.client.todoRestore(user, "deal", cloudId, randomUUID());
    if (res.kind === "transport") return { success: false, error: "offline" };
    if (res.kind !== "ok") return { success: false, error: "unavailable" };
    const status = str(((res.body.results as Array<Record<string, unknown>> | undefined) ?? [])[0]?.status);
    if (status === "restored" || status === "not_removed") return { success: true };
    return { success: false, error: status === "not_found" ? "not_found" : "not_restorable" };
  }
}

/** The provider names the portal uses (broker-portal/lib/mcp/account/messages.ts PROVIDER_LABELS). */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "Claude",
  openai: "ChatGPT",
});
