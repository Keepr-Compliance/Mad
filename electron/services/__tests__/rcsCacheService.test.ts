/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 — the cache job's rules (pure).
 *
 * Mutation controls (each turns a test red):
 *   R1 since without the max (always 60 days, or always last − 1 day) → "since"
 *   R2 a refusal skipped (signed out / not opted in / busy / running)   → "who may start"
 *   R3 the finish time saved after a cancel or an error                 → "saved only on success"
 *   R4 (atomic import) a cancel/error commits, links, or keeps staging  → "cancelled or failed: discard only"
 *   R4b a failed commit still saving the time or linking                → "a failed commit saves nothing"
 *   S1 views told to refetch before the auto-link, or after a discard   → "finished: committed"
 *   R5 a transaction Sync treated as a cache Sync                       → "a transaction Sync is left alone"
 *   R6 the finish time = now instead of the job start (SR P1)           → "the job START time is saved"
 *   R8 the hello throttle off by one or missing                         → "hello at most once a minute"
 *   R9 a sign-out / user switch not cancelling, or a refresh cancelling  → "session changes"
 *   W1 the months setting ignored (always 60 days)                     → "cacheWindow: the months setting"
 *   W2 the incremental rule dropped                                    → "cacheWindow: the months setting"
 *   W3 the dev override honoured in a packaged build                   → "cacheWindow: dev override"
 *   W4 the dev override not clamped 1..3650                            → "clampSinceDays"
 *   W5 the cap or the audit spans not passed to the commit              → "cacheWindow: limits"
 */

import {
  cacheSince,
  cacheWindow,
  clampSinceDays,
  cancelOnSessionChange,
  decideCacheStart,
  handleCacheJobEnded,
  RCS_CACHE_WINDOW_DAYS,
  RCS_HELLO_PERSIST_MS,
  shouldPersistHello,
} from "../rcsCacheService";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");

describe("since: max(now − 60 days, last finished − 1 day)", () => {
  it("first run (nothing finished yet, or junk): 60 days back (R1)", () => {
    expect(RCS_CACHE_WINDOW_DAYS).toBe(60);
    expect(cacheSince(NOW, null)).toBe(new Date(NOW - 60 * DAY).toISOString());
    expect(cacheSince(NOW, "not a date")).toBe(new Date(NOW - 60 * DAY).toISOString());
  });

  it("a recent run: one day before it (R1)", () => {
    expect(cacheSince(NOW, "2026-09-30T12:00:00.000Z")).toBe("2026-09-29T12:00:00.000Z");
  });

  it("a run longer ago than 60 days: still only 60 days (R1)", () => {
    expect(cacheSince(NOW, "2026-01-01T00:00:00.000Z")).toBe(new Date(NOW - 60 * DAY).toISOString());
  });
});

describe("who may start a cache Sync (R2)", () => {
  const ok = { userId: "u-1", optedIn: true, activeLabel: null, writesPaused: false };
  it("signed in, opted in, nothing running: yes", () => {
    expect(decideCacheStart(ok)).toEqual({ ok: true, userId: "u-1" });
  });
  it("signed out: 403", () => {
    expect(decideCacheStart({ ...ok, userId: null })).toMatchObject({ status: 403, error: "signed_out" });
  });
  it("not opted in: 403", () => {
    expect(decideCacheStart({ ...ok, optedIn: false })).toMatchObject({ status: 403, error: "not_opted_in" });
  });
  it("a Force re-import is clearing texts: 503", () => {
    expect(decideCacheStart({ ...ok, writesPaused: true })).toMatchObject({ status: 503, error: "busy" });
  });
  it("a Sync is running: 409, naming it", () => {
    expect(decideCacheStart({ ...ok, activeLabel: "1 Test Street" })).toMatchObject({
      status: 409,
      error: "already_syncing",
      message: "Keepr is already syncing: 1 Test Street. Wait for it to finish, or cancel it.",
    });
    expect(decideCacheStart({ ...ok, activeLabel: "" })).toMatchObject({ status: 409 });
  });
});

describe("when a cache Sync ends", () => {
  function deps() {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        saveFinishedAt: (u: string, iso: string) => void calls.push(`finished ${u} ${iso}`),
        saveOwnNumber: (u: string, n: string) => void calls.push(`own ${u} ${n}`),
        commit: async (j: string, u: string) => {
          calls.push(`commit ${j} ${u}`);
        },
        discard: async (j: string) => {
          calls.push(`discard ${j}`);
        },
        autoLink: async (u: string) => {
          calls.push(`autolink ${u}`);
        },
        onSaved: (u: string) => void calls.push(`saved ${u}`),
        now: () => NOW,
      },
    };
  }
  const ended = (state: string, kind = "cache", own: string | null = null) => ({
    kind, userId: "u-1", snapshot: { state, jobId: "job-1" }, detectedOwnNumber: own,
  });

  it("finished: committed (one transaction), then the time is saved, then the auto-link for that user", async () => {
    const d = deps();
    await handleCacheJobEnded(ended("finished"), d.deps);
    expect(d.calls).toEqual(["commit job-1 u-1", `finished u-1 ${new Date(NOW).toISOString()}`, "autolink u-1", "saved u-1"]);
  });

  // BACKLOG-3658 atomic import: nothing was written, so nothing to link.
  it("cancelled or failed: discard only — no time saved, no commit, no auto-link (R3, R4)", async () => {
    for (const state of ["cancelled", "failed"]) {
      const d = deps();
      await handleCacheJobEnded(ended(state), d.deps);
      expect([state, d.calls]).toEqual([state, ["discard job-1"]]);
    }
  });

  it("a failed commit saves nothing and links nothing; the error is logged (R4b)", async () => {
    const d = deps();
    const logs: string[] = [];
    await expect(handleCacheJobEnded(ended("finished"), {
      ...d.deps,
      commit: async () => {
        throw new Error("disk full");
      },
      log: (m) => void logs.push(m),
    })).resolves.toBeUndefined();
    expect(d.calls).toEqual([]);
    expect(logs[0]).toContain("disk full");
  });

  it("a detected own number (3+ chats agreed) is kept for the next run", async () => {
    const d = deps();
    await handleCacheJobEnded(ended("cancelled", "cache", "+15555550100"), d.deps);
    expect(d.calls).toEqual(["own u-1 +15555550100", "discard job-1"]);
  });

  it("the job START time is saved, not the finish time (R6)", async () => {
    const d = deps();
    await handleCacheJobEnded(
      { kind: "cache", userId: "u-1", snapshot: { state: "finished", createdAt: "2026-10-01T11:00:00.000Z", jobId: "job-1" }, detectedOwnNumber: null },
      d.deps,
    );
    expect(d.calls[1]).toBe("finished u-1 2026-10-01T11:00:00.000Z");
  });

  it("a transaction Sync is left alone (R5)", async () => {
    const d = deps();
    await handleCacheJobEnded(ended("finished", "transaction"), d.deps);
    expect(d.calls).toEqual([]);
  });

  it("an auto-link error is logged, never thrown", async () => {
    const logs: string[] = [];
    await expect(handleCacheJobEnded(ended("finished"), {
      ...deps().deps,
      autoLink: async () => {
        throw new Error("db busy");
      },
      log: (m) => void logs.push(m),
    })).resolves.toBeUndefined();
    expect(logs[0]).toContain("db busy");
  });
});

// BACKLOG-3658: the same settings as every other source (the import plan).
describe("cacheWindow", () => {
  const plan = (fetchStartISO: string | null, effectiveCap: number | null = 50000) => ({
    fetchStartISO, effectiveCap, protectedSpans: [] as Array<{ startNano: number; endNano: number | null }>,
  });
  const threeMonths = "2026-07-01T12:00:00.000Z";

  it("the months setting: the floor; since = max(floor, last − 1 day) (W1, W2)", () => {
    const first = cacheWindow({ nowMs: NOW, lastFinishedAt: null, plan: plan(threeMonths), isPackaged: true });
    expect(first.since).toBe(threeMonths);
    expect(first.limits.floorMs).toBe(Date.parse(threeMonths));
    const later = cacheWindow({ nowMs: NOW, lastFinishedAt: "2026-09-30T08:00:00.000Z", plan: plan(threeMonths), isPackaged: true });
    expect(later.since).toBe("2026-09-29T08:00:00.000Z");
    expect(later.limits.floorMs).toBe(Date.parse(threeMonths));
    // All time: 3650 days at most.
    expect(cacheWindow({ nowMs: NOW, lastFinishedAt: null, plan: plan(null), isPackaged: true }).limits.floorMs)
      .toBe(NOW - 3650 * DAY);
  });

  it("limits: the cap and the audit periods (Apple-epoch ns → ms) go to the commit (W5)", () => {
    const startMs = Date.parse("2026-05-01T00:00:00.000Z");
    const nano = (ms: number) => (ms - 978307200000) * 1_000_000;
    const w = cacheWindow({
      nowMs: NOW, lastFinishedAt: null, isPackaged: true,
      plan: { fetchStartISO: threeMonths, effectiveCap: 1000, protectedSpans: [{ startNano: nano(startMs), endNano: null }] },
    });
    expect(w.limits.cap).toBe(1000);
    expect(w.limits.protectedSpans).toEqual([{ startMs, endMs: null }]);
  });

  it("dev override: honoured only when NOT packaged; it skips the incremental rule (W3)", () => {
    const dev = cacheWindow({ nowMs: NOW, lastFinishedAt: "2026-09-30T08:00:00.000Z", plan: plan(threeMonths), sinceDays: 400, isPackaged: false });
    expect(dev.devOverrideDays).toBe(400);
    expect(dev.since).toBe(new Date(NOW - 400 * DAY).toISOString());
    expect(dev.limits.floorMs).toBe(NOW - 400 * DAY);
    const packaged = cacheWindow({ nowMs: NOW, lastFinishedAt: null, plan: plan(threeMonths), sinceDays: 400, isPackaged: true });
    expect(packaged.devOverrideDays).toBeNull();
    expect(packaged.since).toBe(threeMonths);
    // No override asked: the setting, even in a dev build.
    expect(cacheWindow({ nowMs: NOW, lastFinishedAt: null, plan: plan(threeMonths), isPackaged: false }).since).toBe(threeMonths);
  });

  it("clampSinceDays: whole days 1..3650; junk → no override (W4)", () => {
    expect(clampSinceDays(0)).toBe(1);
    expect(clampSinceDays(-5)).toBe(1);
    expect(clampSinceDays(99999)).toBe(3650);
    expect(clampSinceDays(30.4)).toBe(30);
    expect(clampSinceDays("30")).toBeNull();
    expect(clampSinceDays(NaN)).toBeNull();
    expect(clampSinceDays(undefined)).toBeNull();
  });
});

describe("hello at most once a minute (R8)", () => {
  it("first always; then only after a full minute", () => {
    expect(shouldPersistHello(undefined, NOW)).toBe(true);
    expect(shouldPersistHello(NOW, NOW + RCS_HELLO_PERSIST_MS - 1)).toBe(false);
    expect(shouldPersistHello(NOW, NOW + RCS_HELLO_PERSIST_MS)).toBe(true);
    expect(RCS_HELLO_PERSIST_MS).toBe(60_000);
  });
});

describe("session changes and a running Sync (R9)", () => {
  it.each([
    ["sign-out", { kind: "cleared" as const, userId: null }, "u-1", true, true],
    ["another user signs in", { kind: "saved" as const, userId: "u-2" }, "u-1", true, true],
    ["a refresh for the same user", { kind: "saved" as const, userId: "u-1" }, "u-1", true, false],
    ["no Sync running", { kind: "cleared" as const, userId: null }, null, false, false],
    ["a save with no user id", { kind: "saved" as const, userId: null }, "u-1", true, false],
  ])("%s", (_label, change, owner, active, cancel) => {
    expect(cancelOnSessionChange(change, owner, active)).toBe(cancel);
  });
});
