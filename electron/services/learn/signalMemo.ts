/**
 * One signal pass per (user, run, latest answer), shared — BACKLOG-4257 (SR R4).
 *
 * learn:signals (the score dialog) and the pilot report job (learn:score's lazy
 * thunk) both ask for the same pass; this memo makes them share it.
 *   - single-flight: a call while a pass with the same key is running joins it;
 *   - a COMPLETE result is reused for `ttlMs` (the pass also reads inputs the key
 *     does not move: deal rejections, contacts, vendor roles, newly synced mail);
 *   - only the newest entry per user is kept; a different key replaces it;
 *   - a rejected pass or a `complete: false` result is never reused.
 * Main-process memory only; nothing is persisted.
 */
import type { SignalScore } from "./signalScoring";

export const SIGNAL_MEMO_TTL_MS = 10 * 60 * 1000;

export interface SignalMemoKey {
  runId: string;
  latestAnswerAt: string | null;
}

interface Entry {
  key: string;
  promise: Promise<SignalScore>;
  /** null while the pass runs. */
  settledAt: number | null;
}

export interface SignalMemo {
  get(userId: string, key: SignalMemoKey, pass: () => Promise<SignalScore>): Promise<SignalScore>;
}

export function createSignalMemo(opts: { ttlMs?: number; now?: () => number } = {}): SignalMemo {
  const ttlMs = opts.ttlMs ?? SIGNAL_MEMO_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const byUser = new Map<string, Entry>();

  return {
    get(userId, k, pass) {
      const key = JSON.stringify([k.runId, k.latestAnswerAt]);
      const hit = byUser.get(userId);
      if (hit && hit.key === key && (hit.settledAt === null || now() - hit.settledAt < ttlMs)) return hit.promise;
      const entry: Entry = { key, promise: Promise.resolve().then(pass), settledAt: null };
      byUser.set(userId, entry);
      entry.promise.then(
        (s) => {
          if (byUser.get(userId) !== entry) return;
          if (s.complete) entry.settledAt = now();
          else byUser.delete(userId);
        },
        () => {
          if (byUser.get(userId) === entry) byUser.delete(userId);
        },
      );
      return entry.promise;
    },
  };
}
