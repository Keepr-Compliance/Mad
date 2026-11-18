/**
 * Request limits for /api/mcp (BACKLOG-4263 PR-10).
 *
 * The counters are in memory and count per server instance. They bound the load one connection puts on one
 * instance. They do not bound a caller whose requests are spread over many instances.
 *
 * Per key (the access-token digest the route already computes, never the token itself):
 * - a fixed window: at most MCP_WINDOW_LIMIT JSON-RPC requests per MCP_WINDOW_MS;
 * - at most MCP_INFLIGHT_LIMIT JSON-RPC requests in flight at once.
 *
 * Per POST:
 * - admitKnownMcpRequest, before the access check: when the key already has an entry, counts the POST and takes
 *   its slot there (or refuses it). It never creates an entry.
 * - admitMcpRequest, after the access check accepted a token with no entry: creates the entry and counts the POST.
 *
 * The map holds at most MCP_MAX_KEYS entries. An entry with an unfinished window or a slot in flight is never
 * deleted to make room. When the map is full, ended idle entries are deleted first; if none exists, the new key is
 * served without an entry for that POST.
 *
 * An in-flight slot ends when it is released (the work finished), MCP_SLOT_ABANDON_MS after it was abandoned
 * (client abort, cancelled or failed stream), and MCP_SLOT_MAX_MS after it started in any case. No timer: everything is evaluated against the clock when an entry is read.
 */

import { RPC_TIMEOUT_MS } from '@/lib/mcp/oauth/rpc';

export const MCP_WINDOW_MS = 60_000;
export const MCP_WINDOW_LIMIT = 60;
export const MCP_INFLIGHT_LIMIT = 4;
/** The most JSON-RPC requests one POST may carry. */
export const MCP_BATCH_LIMIT = 4;
export const MCP_MAX_KEYS = 20_000;
export const MCP_SWEEP_PER_CALL = 100;
/** The route's maxDuration (app/api/mcp/route.ts), in ms. */
export const MCP_SLOT_MAX_MS = 60_000;
/**
 * Assumes each tool makes one database call, which the portal cuts off after RPC_TIMEOUT_MS (lib/mcp/oauth/rpc.ts).
 */
export const MCP_SLOT_ABANDON_MS = RPC_TIMEOUT_MS + 1_000;

interface Slot {
  n: number;
  endsAt: number;
}

interface Entry {
  count: number;
  windowStart: number;
  slots: Set<Slot>;
}

export type Refusal = 'window' | 'inflight';

export interface McpSlot {
  /** The work finished: the slot ends now. */
  release(): void;
  /** The work may still run: the slot ends MCP_SLOT_ABANDON_MS from now, or earlier at MCP_SLOT_MAX_MS. */
  abandon(): void;
}

export type Admission = { ok: true; slot: McpSlot } | { ok: false; reason: Refusal };

const NO_SLOT: McpSlot = { release: () => {}, abandon: () => {} };

let entries = new Map<string, Entry>();
let clock: () => number = Date.now;

function inFlight(e: Entry, t: number): number {
  let n = 0;
  for (const s of e.slots) {
    if (s.endsAt <= t) e.slots.delete(s);
    else n += s.n;
  }
  return n;
}

const windowEnded = (e: Entry, t: number) => t - e.windowStart >= MCP_WINDOW_MS;
const idle = (e: Entry, t: number) => windowEnded(e, t) && inFlight(e, t) === 0;

function renew(key: string, e: Entry, t: number): void {
  if (!windowEnded(e, t)) return;
  // A new window: the key moves to the new end of the map, so the old end holds the oldest windows.
  entries.delete(key);
  e.count = 0;
  e.windowStart = t;
  entries.set(key, e);
}

function sweep(t: number, limit: number): void {
  let seen = 0;
  for (const [key, e] of entries) {
    if (seen++ >= limit) break;
    if (idle(e, t)) entries.delete(key);
  }
}

function refusal(e: Entry, t: number, windowCost: number, inFlightCost: number): Refusal | null {
  if (e.count + windowCost > MCP_WINDOW_LIMIT) return 'window';
  if (inFlight(e, t) + inFlightCost > MCP_INFLIGHT_LIMIT) return 'inflight';
  return null;
}

/**
 * Before the access check: null when `key` has no entry (nothing is created). Otherwise counts the POST and takes
 * its slot, or refuses it, as admitMcpRequest does.
 */
export function admitKnownMcpRequest(key: string, windowCost: number, inFlightCost: number): Admission | null {
  if (!entries.has(key)) return null;
  return admitMcpRequest(key, windowCost, inFlightCost);
}

/**
 * Count one POST for `key`, creating its entry when needed: call it only for a token the access check accepted. `windowCost` counts toward the window,
 * `inFlightCost` toward the in-flight cap. All or nothing: a refused POST changes no counter.
 */
export function admitMcpRequest(key: string, windowCost: number, inFlightCost: number): Admission {
  const t = clock();
  sweep(t, MCP_SWEEP_PER_CALL);
  let e = entries.get(key);
  if (e) {
    renew(key, e, t);
  } else {
    if (entries.size >= MCP_MAX_KEYS) sweep(t, Infinity);
    if (entries.size >= MCP_MAX_KEYS) return { ok: true, slot: NO_SLOT };
    e = { count: 0, windowStart: t, slots: new Set() };
    entries.set(key, e);
  }
  const reason = refusal(e, t, windowCost, inFlightCost);
  if (reason) return { ok: false, reason };
  e.count += windowCost;
  if (inFlightCost === 0) return { ok: true, slot: NO_SLOT };
  const slot: Slot = { n: inFlightCost, endsAt: t + MCP_SLOT_MAX_MS };
  e.slots.add(slot);
  const held = e;
  return {
    ok: true,
    slot: {
      release: () => {
        held.slots.delete(slot);
      },
      abandon: () => {
        slot.endsAt = Math.min(slot.endsAt, clock() + MCP_SLOT_ABANDON_MS);
      },
    },
  };
}

/** Clears every counter (tests). */
export function resetMcpRateLimitsForTests(): void {
  entries = new Map();
  clock = Date.now;
}

/** Replaces the clock (tests). */
export function setMcpRateLimitClockForTests(now: () => number): void {
  clock = now;
}

/** The keys held (tests). */
export function mcpRateLimitKeysForTests(): string[] {
  return [...entries.keys()];
}

/** The window count and the in-flight number of a key, or null when it has no entry (tests). */
export function mcpRateLimitStateForTests(key: string): { count: number; inFlight: number } | null {
  const e = entries.get(key);
  return e ? { count: e.count, inFlight: inFlight(e, clock()) } : null;
}
