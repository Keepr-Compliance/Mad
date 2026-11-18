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
 * The key map holds at most MCP_MAX_KEYS keys. When it is full, the oldest key is deleted, so a new key is always
 * admitted and the deleted key starts again from zero. No timer: an entry whose window has ended is renewed when it
 * is read, and each call deletes up to MCP_SWEEP_PER_CALL ended, idle entries from the old end of the map.
 */

export const MCP_WINDOW_MS = 60_000;
export const MCP_WINDOW_LIMIT = 60;
export const MCP_INFLIGHT_LIMIT = 4;
/** The most JSON-RPC requests one POST may carry. */
export const MCP_BATCH_LIMIT = 4;
export const MCP_MAX_KEYS = 20_000;
export const MCP_SWEEP_PER_CALL = 100;

interface Entry {
  count: number;
  windowStart: number;
  inFlight: number;
}

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'window' | 'inflight' };

let entries = new Map<string, Entry>();
let clock: () => number = Date.now;

const ended = (e: Entry, t: number) => t - e.windowStart >= MCP_WINDOW_MS;

function sweep(t: number): void {
  let seen = 0;
  for (const [key, e] of entries) {
    if (seen++ >= MCP_SWEEP_PER_CALL) break;
    if (e.inFlight === 0 && ended(e, t)) entries.delete(key);
  }
}

function entryFor(key: string, t: number): Entry {
  const e = entries.get(key);
  if (e) {
    if (ended(e, t)) {
      // A new window: move the key to the new end of the map, so the old end holds the oldest windows.
      // The same object is kept, so a release taken in the old window still finds it.
      entries.delete(key);
      e.count = 0;
      e.windowStart = t;
      entries.set(key, e);
    }
    return e;
  }
  if (entries.size >= MCP_MAX_KEYS) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  const created = { count: 0, windowStart: t, inFlight: 0 };
  entries.set(key, created);
  return created;
}

/**
 * Admit one POST for `key`: `windowCost` counts toward the window, `inFlightCost` toward the in-flight cap.
 * All or nothing: a refused POST changes no counter. The returned release gives the in-flight slots back once;
 * it does nothing after the key was deleted or the limiter was reset.
 */
export function admitMcpRequest(key: string, windowCost: number, inFlightCost: number): Admission {
  const t = clock();
  sweep(t);
  const e = entryFor(key, t);
  if (e.count + windowCost > MCP_WINDOW_LIMIT) return { ok: false, reason: 'window' };
  if (e.inFlight + inFlightCost > MCP_INFLIGHT_LIMIT) return { ok: false, reason: 'inflight' };
  e.count += windowCost;
  e.inFlight += inFlightCost;
  let released = inFlightCost === 0;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      // A deleted (evicted or reset) key's entry is gone: its release changes nothing.
      if (entries.get(key) !== e) return;
      e.inFlight = Math.max(0, e.inFlight - inFlightCost);
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
