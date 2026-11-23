/**
 * Keepr Cloud children of one deal — BACKLOG-4243 PR-3.
 *
 * Builds the people of a deal and decides what
 * a pass sends and what it tombstones, from local rows and this database's
 * sync records. No I/O beyond the reads passed in.
 *
 * Send when: no record, the record is removed, the hash or hash version
 * differs, or the record belongs to another deal (the row moved). A moved row's
 * old online copy is tombstoned first, so the person does not stay on the old
 * deal online. Tombstone when: a live record of this deal has no live local row.
 *
 * Checklists and items are not children here since BACKLOG-4263 PR-4a: they are sent as todo changes
 * (todos/sender.ts), and the two old one-way item functions are dropped online (migration 20261118120000).
 */
import type { ChildStateRow, DealChildRows } from "../db/cloudSyncDbService";
import type { MessageStateRow } from "../db/cloudSyncMessagesDb";
import { MESSAGE_HASH_VERSION, type ProjectedMessage } from "./messageProjection";
import {
  buildPartyDto,
  HASH_VERSION,
  projectChild,
  type ChildKind,
  type PartySource,
  type ProjectedChild,
} from "./projection";

export const CHILD_KINDS: readonly ChildKind[] = ["party"];
/** Server caps per call (migration 20261112190000 CAP:rows, CAP:tombstone); bytes kept well under 16 MB. */
export const MAX_ROWS_PER_CALL = 500;
export const MAX_BYTES_PER_CALL = 8 * 1024 * 1024;
export const MAX_TOMBSTONES_PER_CALL = 1000;

export interface ChildTombstone {
  kind: ChildKind;
  localId: string;
  cloudId: string;
}

export interface ChildPlan {
  /** Old online copies of rows that moved to this deal; tombstoned before anything is sent. */
  moved: ChildTombstone[];
  send: Record<ChildKind, ProjectedChild[]>;
  tombstone: ChildTombstone[];
}

function localIdOf(row: Record<string, unknown>): string {
  return String(row.id);
}

/** Projects every live child of the deal. */
export function projectChildren(rows: DealChildRows): Record<ChildKind, ProjectedChild[]> {
  const contacts = new Map(rows.contacts.map((c) => [String(c.id), c]));
  const byContact = <T extends Record<string, unknown>>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of list) {
      const k = String(r.contact_id);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const emails = byContact(rows.emails);
  const phones = byContact(rows.phones);
  const links = byContact(rows.sourceLinks);
  const parties = rows.parties
    .filter((p) => p.removed_at === null || p.removed_at === undefined)
    .map((p) => {
      const cid = String(p.contact_id);
      const source: PartySource = {
        row: p,
        contact: contacts.get(cid) ?? null,
        emails: emails.get(cid) ?? [],
        phones: phones.get(cid) ?? [],
        sourceTypes: (links.get(cid) ?? []).map((l) => String(l.source_type)),
      };
      return projectChild("party", localIdOf(p), buildPartyDto(source));
    });
  return { party: parties };
}

export function planChildren(
  transactionId: string,
  projected: Record<ChildKind, ProjectedChild[]>,
  ofDeal: ChildStateRow[],
  byLocal: (kind: ChildKind, localId: string) => ChildStateRow | null,
): ChildPlan {
  const plan: ChildPlan = { moved: [], send: { party: [] }, tombstone: [] };
  for (const kind of CHILD_KINDS) {
    const live = new Set<string>();
    for (const p of projected[kind]) {
      live.add(p.localId);
      const st = byLocal(kind, p.localId);
      if (st && st.transaction_id !== transactionId && st.cloud_id && st.removed === 0) {
        plan.moved.push({ kind, localId: p.localId, cloudId: st.cloud_id });
      }
      const same =
        st !== null &&
        st.transaction_id === transactionId &&
        st.removed === 0 &&
        st.cloud_id !== null &&
        st.content_hash === p.hash &&
        st.hash_version === HASH_VERSION;
      if (!same) plan.send[kind].push(p);
    }
    for (const st of ofDeal) {
      if (st.entity !== kind || st.removed !== 0 || !st.cloud_id) continue;
      if (!live.has(st.local_id)) plan.tombstone.push({ kind, localId: st.local_id, cloudId: st.cloud_id });
    }
  }
  return plan;
}

export function hasChildWork(plan: ChildPlan): boolean {
  return plan.moved.length > 0 || plan.tombstone.length > 0 || CHILD_KINDS.some((k) => plan.send[k].length > 0);
}

/** Splits rows into calls of at most MAX_ROWS_PER_CALL rows and MAX_BYTES_PER_CALL serialised bytes. */
export function batches<T extends { payload: unknown }>(rows: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 2;
  for (const r of rows) {
    const size = Buffer.byteLength(JSON.stringify(r.payload), "utf8") + 1;
    if (cur.length > 0 && (cur.length >= MAX_ROWS_PER_CALL || bytes + size > MAX_BYTES_PER_CALL)) {
      out.push(cur);
      cur = [];
      bytes = 2;
    }
    cur.push(r);
    bytes += size;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- emails and texts (BACKLOG-4263 P5)

export interface MessageTombstone {
  key: string;
  cloudId: string;
}

export interface MessagePlan {
  send: ProjectedMessage[];
  /** Live records of this deal whose key is not in the deal's selected set (never decided by row existence). */
  tombstone: MessageTombstone[];
}

/**
 * Send when the switch is on and: no record, the record is removed, has no online id, or its hash or hash version
 * differs. Tombstone (switch on or off) a live record of this deal whose key is not selected.
 */
export function planMessages(selected: ProjectedMessage[], records: MessageStateRow[], uploadOn: boolean): MessagePlan {
  const byKey = new Map(records.map((r) => [r.local_id, r]));
  const live = new Set(selected.map((m) => m.key));
  const send = uploadOn
    ? selected.filter((m) => {
        const st = byKey.get(m.key);
        return !(st && st.removed === 0 && st.cloud_id !== null && st.content_hash === m.hash && st.hash_version === MESSAGE_HASH_VERSION);
      })
    : [];
  const tombstone: MessageTombstone[] = [];
  for (const r of records) {
    if (r.removed !== 0 || !r.cloud_id || live.has(r.local_id)) continue;
    tombstone.push({ key: r.local_id, cloudId: r.cloud_id });
  }
  return { send, tombstone };
}

export function hasMessageWork(plan: MessagePlan): boolean {
  return plan.send.length > 0 || plan.tombstone.length > 0;
}
