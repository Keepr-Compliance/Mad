/**
 * Direction-aware 1:1 identity of text threads (BACKLOG-2287), shared by the main
 * process and the contact query worker (BACKLOG-3816 PC final check, 2026-10-10).
 *
 * Moved unchanged from `autoLinkService.ts` so the worker thread can build the same
 * index the main thread used to build itself: on the founder's PC the scan of every
 * text message (~671k rows) plus the JSON parse of each row blocked the main process
 * for 11-13 s after every transaction update and 57 s after a sync.
 *
 * No database and no Electron import here: the worker loads this file.
 */
import { handleToIdentityToken } from "./handleIdentity";

export interface ThreadIdentityRow {
  thread_id: string;
  direction: string | null;
  participants: string | null;
}

/**
 * Compute the DIRECTION-AWARE set of external (non-user) identity tokens for a
 * thread from its messages' `participants` JSON.
 *
 * - inbound  → take `from` only (the contact; `to` is the user's own handle)
 * - outbound → take `to`   only (the contact; `from` is the user's own handle)
 * - always   → take `chat_members` (authoritative group signal — present only when
 *              the chat has >1 member, so it never pollutes a genuine 1:1 and
 *              always inflates a group to >1 identity).
 *
 * A genuine 1:1 thread therefore resolves to EXACTLY ONE token; a group resolves
 * to >1 (the C1 gate) even if only one member has spoken in our data.
 */
export function computeThreadIdentitySet(
  rows: Array<{ direction: string | null; participants: string | null }>,
): Set<string> {
  const tokens = new Set<string>();
  for (const row of rows) {
    if (!row.participants) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.participants);
    } catch {
      continue; // skip invalid JSON (mirrors renderer)
    }
    if (!parsed || typeof parsed !== "object") continue;
    const p = parsed as { from?: unknown; to?: unknown; chat_members?: unknown };

    if (Array.isArray(p.chat_members)) {
      for (const m of p.chat_members) {
        const t = handleToIdentityToken(String(m));
        if (t) tokens.add(t);
      }
    }
    if (row.direction === "inbound" && typeof p.from === "string") {
      const t = handleToIdentityToken(p.from);
      if (t) tokens.add(t);
    }
    if (row.direction === "outbound" && p.to !== null && p.to !== undefined) {
      const toList = Array.isArray(p.to) ? p.to : [p.to];
      for (const raw of toList) {
        const t = handleToIdentityToken(String(raw));
        if (t) tokens.add(t);
      }
    }
  }
  return tokens;
}

/**
 * Every thread that is ITSELF a 1:1 conversation, with its one identity token.
 * Identity is computed from ALL of a thread's rows, so a group (>1 identity) and a
 * thread with no identity are both absent. Pairs, not a Map: it crosses postMessage.
 */
export function buildOneToOneThreadIndex(rows: Iterable<ThreadIdentityRow>): Array<[string, string]> {
  const rowsByThread = new Map<string, Array<{ direction: string | null; participants: string | null }>>();
  for (const r of rows) {
    let arr = rowsByThread.get(r.thread_id);
    if (!arr) {
      arr = [];
      rowsByThread.set(r.thread_id, arr);
    }
    arr.push({ direction: r.direction, participants: r.participants });
  }
  const out: Array<[string, string]> = [];
  for (const [tid, rws] of rowsByThread) {
    const idSet = computeThreadIdentitySet(rws);
    if (idSet.size === 1) out.push([tid, [...idSet][0]]);
  }
  return out;
}
