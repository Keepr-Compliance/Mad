/**
 * Keepr Cloud: what goes up of a deal's emails and texts, and the local records of it — BACKLOG-4263 P5.
 *
 * THE SELECTION RULE lives here and nowhere else: every `communications` row of the deal, whatever its
 * `link_source` (Needs review included), through the two arms the Texts tab and the export read
 * (`getCommunicationsWithMessages`, communicationDbService.ts): a per-message link, or a whole-thread link
 * restricted to the linking user's copy of the thread; and the email arm. No date window. The review queue
 * (`pending_review_communications`) is never read. Owner copies and duplicates are collapsed by the same
 * `dedupeLinkedCommunicationRows`. Texts hidden from exports are NOT dropped: they carry `hidden_from_export`,
 * and so do reactions to them (the export's own rule, exportPlan.ts).
 *
 * The order before the de-duplication is total (sent time, content id, link id), so the same rows always
 * survive and carry the same link.
 */
import type { SqlDb } from "./cloudSyncSqlDb";
import { dedupeLinkedCommunicationRows } from "./linkedRowDedup";
import type { Communication } from "../../types";
import { isReactionRow } from "../../utils/reactionUtils";
import { cleanText } from "../cloudSync/projection";
import {
  ADOPT_MESSAGE_STATE_SQL,
  DELETE_SWITCH_MARKER_SQL,
  MARK_ALL_ELIGIBLE_FOR_USER_SQL,
  MARK_MESSAGE_GONE_SQL,
  MESSAGE_RECONCILE_ID,
  MESSAGES_UPLOAD_ID,
  SELECT_MESSAGE_STATE_OF_DEAL_SQL,
  SELECT_MESSAGE_STATE_OF_USER_SQL,
  SELECT_SWITCH_VALUE_SQL,
  UPSERT_SWITCH_VALUE_SQL,
} from "./cloudSyncSql";

export const MESSAGE_ENTITY = "message" as const;
/** Server key limit for `local_id` (S2 `length(r ->> 'local_id') BETWEEN 1 AND 200`, characters). */
export const MAX_WIRE_ID_CODE_POINTS = 200;

export const SELECT_DEAL_MESSAGES_SQL = `
  SELECT
    COALESCE(m.id, e.id) AS id,
    m.id AS message_row_id,
    e.id AS email_row_id,
    c.id AS communication_id,
    c.user_id,
    c.transaction_id,
    c.link_source,
    c.link_confidence,
    c.match_reason,
    c.linked_at,
    CASE WHEN m.id IS NOT NULL THEN m.channel ELSE 'email' END AS channel,
    CASE WHEN m.id IS NOT NULL THEN m.channel ELSE 'email' END AS communication_type,
    COALESCE(m.body_text, e.body_plain) AS body_text,
    e.body_html AS email_body_html,
    COALESCE(m.subject, e.subject) AS subject,
    COALESCE(m.sent_at, e.sent_at) AS sent_at,
    COALESCE(m.received_at, e.received_at) AS received_at,
    COALESCE(m.thread_id, e.thread_id) AS thread_id,
    COALESCE(m.direction, e.direction) AS direction,
    m.participants AS participants,
    e.sender AS sender,
    e.recipients AS recipients,
    e.cc AS cc,
    m.external_id AS external_id,
    m.associated_message_type AS associated_message_type,
    m.associated_message_guid AS associated_message_guid,
    EXISTS (SELECT 1 FROM transaction_hidden_texts h
             WHERE h.transaction_id = c.transaction_id
               AND (h.message_id = m.id
                    OR (h.message_external_id IS NOT NULL AND h.message_external_id = m.external_id))
    ) AS hidden_from_export
  FROM communications c
  LEFT JOIN messages m ON (
    (c.message_id IS NOT NULL AND c.message_id = m.id)
    OR
    (c.message_id IS NULL AND c.email_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id
     AND +m.user_id = c.user_id)
  )
  LEFT JOIN emails e ON (c.email_id IS NOT NULL AND c.email_id = e.id)
  WHERE c.transaction_id = ?
    AND (m.id IS NOT NULL OR e.id IS NOT NULL)
  ORDER BY COALESCE(m.sent_at, e.sent_at) DESC, COALESCE(m.id, e.id) DESC, c.id DESC
`;

export interface SelectedRow {
  id: string;
  message_row_id: string | null;
  email_row_id: string | null;
  communication_id: string;
  user_id: string;
  transaction_id: string;
  link_source: string | null;
  link_confidence: number | null;
  match_reason: string | null;
  linked_at: string | null;
  channel: string | null;
  body_text: string | null;
  email_body_html: string | null;
  subject: string | null;
  sent_at: string | null;
  received_at: string | null;
  thread_id: string | null;
  direction: string | null;
  participants: string | null;
  sender: string | null;
  recipients: string | null;
  cc: string | null;
  external_id: string | null;
  associated_message_type: number | null;
  associated_message_guid: string | null;
  hidden_from_export: number | boolean;
}

export interface SelectedMessage {
  /** The local record key: `<transaction_id>|<channel_kind>|<wire id>`. */
  key: string;
  channelKind: "email" | "text";
  /** The server key `local_id`: emails.id; for a text its external_id (1-200 code points) else messages.id. */
  wireId: string;
  /** Hidden from exports, or a reaction to a text hidden from exports. */
  hidden: boolean;
  row: SelectedRow;
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function recordKey(transactionId: string, channelKind: string, wireId: string): string {
  return `${transactionId}|${channelKind}|${wireId}`;
}

/** Splits a record key on its first two `|` only (a wire id may hold any character). */
export function parseRecordKey(key: string): { transactionId: string; channelKind: string; wireId: string } | null {
  const a = key.indexOf("|");
  const b = a < 0 ? -1 : key.indexOf("|", a + 1);
  if (a <= 0 || b <= a + 1 || b === key.length - 1) return null;
  return { transactionId: key.slice(0, a), channelKind: key.slice(a + 1, b), wireId: key.slice(b + 1) };
}

function wireIdOf(row: SelectedRow): string | null {
  if (row.email_row_id && !row.message_row_id) return row.email_row_id;
  const ext = cleanText(row.external_id);
  if (ext && ext.length > 0 && codePoints(ext) <= MAX_WIRE_ID_CODE_POINTS) return ext;
  const id = cleanText(row.message_row_id);
  return id && id.length > 0 && codePoints(id) <= MAX_WIRE_ID_CODE_POINTS ? id : null;
}

function isText(row: SelectedRow): boolean {
  return row.message_row_id !== null && row.channel !== "email";
}

/** The deal's attached emails and texts, in the order of the reader above, one per server key. */
export function selectDealMessages(db: SqlDb, transactionId: string): SelectedMessage[] {
  const raw = db.prepare(SELECT_DEAL_MESSAGES_SQL).all(transactionId) as SelectedRow[];
  const rows = dedupeLinkedCommunicationRows(raw as unknown as Communication[]) as unknown as SelectedRow[];
  // The export's rule (exportPlan.ts): parent guids of hidden texts over the WHOLE deal.
  const hiddenGuids = new Set<string>();
  for (const r of rows) {
    if (isText(r) && !isReactionRow(r) && !!r.hidden_from_export && r.external_id) hiddenGuids.add(r.external_id);
  }
  const out: SelectedMessage[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const channelKind = isText(r) ? "text" : "email";
    const wireId = wireIdOf(r);
    if (!wireId) continue;
    const key = recordKey(transactionId, channelKind, wireId);
    if (seen.has(key)) continue;
    seen.add(key);
    const reactionToHidden = isReactionRow(r) && !!r.associated_message_guid && hiddenGuids.has(r.associated_message_guid);
    out.push({ key, channelKind, wireId, hidden: channelKind === "text" && (!!r.hidden_from_export || reactionToHidden), row: r });
  }
  return out;
}

// ---------------------------------------------------------------- records

export interface MessageStateRow {
  local_id: string;
  transaction_id: string;
  cloud_id: string | null;
  content_hash: string | null;
  hash_version: number | null;
  removed: number;
  last_status: string | null;
}

export function messageStatesOfDeal(db: SqlDb, projectRef: string, userId: string, transactionId: string): MessageStateRow[] {
  return db.prepare(SELECT_MESSAGE_STATE_OF_DEAL_SQL).all(projectRef, userId, transactionId) as MessageStateRow[];
}

export function messageStatesOfUser(
  db: SqlDb,
  projectRef: string,
  userId: string,
): Array<{ local_id: string; transaction_id: string; cloud_id: string | null; cloud_deal_id: string | null; content_hash: string | null; removed: number }> {
  return db.prepare(SELECT_MESSAGE_STATE_OF_USER_SQL).all(projectRef, userId) as never;
}

// ---------------------------------------------------------------- the reconcile marker

export const MESSAGE_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MESSAGE_RECONCILE_BACKOFF_MS = 15 * 60 * 1000;

export interface ReconcileMarker {
  status: "ok" | "failed";
  failures: number;
  at: string;
}

/** The marker, or null when absent or not a well-formed ok / failed row (both count as due). */
export function readReconcileMarker(db: SqlDb, projectRef: string, userId: string): ReconcileMarker | null {
  const r = db.prepare(SELECT_SWITCH_VALUE_SQL).get(projectRef, userId, MESSAGE_RECONCILE_ID) as
    | { last_status: unknown; cloud_version: unknown; updated_at: unknown }
    | undefined;
  if (!r) return null;
  if (r.last_status !== "ok" && r.last_status !== "failed") return null;
  if (typeof r.updated_at !== "string" || !Number.isFinite(Date.parse(r.updated_at))) return null;
  const failures = typeof r.cloud_version === "number" && Number.isInteger(r.cloud_version) && r.cloud_version >= 0 ? r.cloud_version : 0;
  return { status: r.last_status, failures, at: r.updated_at };
}

/** Due: absent or malformed; ok and 24 h old; failed and past its back-off (15 min doubling, at most 24 h). */
export function messageReconcileDue(marker: ReconcileMarker | null, now: Date): boolean {
  if (!marker) return true;
  const age = now.getTime() - Date.parse(marker.at);
  if (marker.status === "ok") return age >= MESSAGE_RECONCILE_INTERVAL_MS;
  const wait = Math.min(MESSAGE_RECONCILE_BACKOFF_MS * 2 ** Math.max(0, Math.min(marker.failures, 20) - 1), MESSAGE_RECONCILE_INTERVAL_MS);
  return age >= wait;
}

export function sameMarker(a: ReconcileMarker | null, b: ReconcileMarker | null): boolean {
  if (a === null || b === null) return a === b;
  return a.status === b.status && a.failures === b.failures && a.at === b.at;
}

export function writeReconcileMarker(db: SqlDb, projectRef: string, userId: string, m: ReconcileMarker): void {
  db.prepare(UPSERT_SWITCH_VALUE_SQL).run(projectRef, userId, MESSAGE_RECONCILE_ID, m.status, m.failures, m.at);
}

export function deleteReconcileMarker(db: SqlDb, projectRef: string, userId: string): void {
  db.prepare(DELETE_SWITCH_MARKER_SQL).run(projectRef, userId, MESSAGE_RECONCILE_ID);
}

/** Every user's marker on this database (after a restore of the file). */
export const DELETE_ALL_RECONCILE_MARKERS_SQL = `DELETE FROM cloud_sync_state WHERE entity = 'switch' AND local_id = '${MESSAGE_RECONCILE_ID}'`;

export interface MessageReconcileWrites {
  adopt: Array<{ key: string; transactionId: string; cloudId: string; cloudDealId: string }>;
  nullHashes: string[];
  gone: string[];
  markDeals: string[];
}

/**
 * The reconcile's local writes, in ONE synchronous transaction (no await inside), after a compare-and-set: the
 * marker is still what the step read before listing, and Keepr Cloud is still on for the user. When either changed
 * (a bulk forget or a turn-off ran meanwhile) nothing is written and false is returned.
 */
export function applyMessageReconcile(
  db: SqlDb,
  projectRef: string,
  userId: string,
  readBefore: ReconcileMarker | null,
  w: MessageReconcileWrites,
  now: Date,
): boolean {
  return db.transaction(() => {
    const on = db.prepare("SELECT enabled FROM cloud_sync_settings WHERE project_ref = ? AND user_id = ?").get(projectRef, userId) as
      | { enabled: number }
      | undefined;
    if (!on || on.enabled !== 1) return false;
    if (!sameMarker(readReconcileMarker(db, projectRef, userId), readBefore)) return false;
    const iso = now.toISOString();
    const adopt = db.prepare(ADOPT_MESSAGE_STATE_SQL);
    for (const a of w.adopt) adopt.run(projectRef, userId, a.key, a.transactionId, a.cloudId, a.cloudDealId, iso);
    const nul = db.prepare(
      "UPDATE cloud_sync_state SET content_hash = NULL, last_status = NULL, removed = 0 WHERE project_ref = ? AND owner_user_id = ? AND entity = 'message' AND local_id = ?",
    );
    for (const k of w.nullHashes) nul.run(projectRef, userId, k);
    const gone = db.prepare(MARK_MESSAGE_GONE_SQL);
    for (const k of w.gone) gone.run(iso, projectRef, userId, k);
    const mark = db.prepare(
      "INSERT INTO cloud_sync_dirty (transaction_id, generation, marked_at) VALUES (?, 1, CURRENT_TIMESTAMP) ON CONFLICT (transaction_id) DO NOTHING",
    );
    for (const id of w.markDeals) mark.run(id);
    writeReconcileMarker(db, projectRef, userId, { status: "ok", failures: 0, at: iso });
    return true;
  })();
}

/** A failed listing: the marker records it (with its count) so the next try waits for the back-off. */
export function recordMessageReconcileFailure(db: SqlDb, projectRef: string, userId: string, readBefore: ReconcileMarker | null, now: Date): void {
  db.transaction(() => {
    if (!sameMarker(readReconcileMarker(db, projectRef, userId), readBefore)) return;
    const failures = readBefore?.status === "failed" ? readBefore.failures + 1 : 1;
    writeReconcileMarker(db, projectRef, userId, { status: "failed", failures, at: now.toISOString() });
  })();
}

// ---------------------------------------------------------------- the messages_upload sentinel (plan §12.2)

/** The last messages_upload value seen; absent (or anything but 1) counts as off. */
export function messagesUploadSeen(db: SqlDb, projectRef: string, userId: string): boolean {
  const r = db.prepare(SELECT_SWITCH_VALUE_SQL).get(projectRef, userId, MESSAGES_UPLOAD_ID) as { cloud_version: unknown } | undefined;
  return r?.cloud_version === 1;
}

/**
 * A state answer's messages_upload value. Off → on: every eligible deal of the user is marked, then the sentinel is
 * set to 1, in one transaction (the mark first). On → off: the sentinel is set to 0. Returns whether it marked.
 */
export function applyMessagesUploadSwitch(db: SqlDb, projectRef: string, userId: string, on: boolean, now: Date): boolean {
  return db.transaction(() => {
    const seen = messagesUploadSeen(db, projectRef, userId);
    if (on === seen) return false;
    if (on) db.prepare(MARK_ALL_ELIGIBLE_FOR_USER_SQL).run(userId);
    db.prepare(UPSERT_SWITCH_VALUE_SQL).run(projectRef, userId, MESSAGES_UPLOAD_ID, null, on ? 1 : 0, now.toISOString());
    return on;
  })();
}
