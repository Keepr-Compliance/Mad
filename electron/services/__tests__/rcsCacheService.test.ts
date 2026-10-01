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
 *   R4 no auto-link after a cancel or an error                          → "auto-link runs whatever the outcome"
 *   R5 a transaction Sync treated as a cache Sync                       → "a transaction Sync is left alone"
 *   R6 the finish time = now instead of the job start (SR P1)           → "the job START time is saved"
 *   R7 a status reason other than signed_out/not_opted_in/busy          → "button status"
 *   R8 the hello throttle off by one or missing                         → "hello at most once a minute"
 *   R9 a sign-out / user switch not cancelling, or a refresh cancelling  → "session changes"
 */

import {
  cacheSince,
  cacheStatusFrom,
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
        autoLink: async (u: string) => {
          calls.push(`autolink ${u}`);
        },
        now: () => NOW,
      },
    };
  }
  const ended = (state: string, kind = "cache", own: string | null = null) => ({
    kind, userId: "u-1", snapshot: { state }, detectedOwnNumber: own,
  });

  it("finished: the time is saved, then the auto-link runs for that user", async () => {
    const d = deps();
    await handleCacheJobEnded(ended("finished"), d.deps);
    expect(d.calls).toEqual([`finished u-1 ${new Date(NOW).toISOString()}`, "autolink u-1"]);
  });

  it("saved only on success; the auto-link runs whatever the outcome (R3, R4)", async () => {
    for (const state of ["cancelled", "failed"]) {
      const d = deps();
      await handleCacheJobEnded(ended(state), d.deps);
      expect([state, d.calls]).toEqual([state, ["autolink u-1"]]);
    }
  });

  it("a detected own number (3+ chats agreed) is kept for the next run", async () => {
    const d = deps();
    await handleCacheJobEnded(ended("cancelled", "cache", "+15555550100"), d.deps);
    expect(d.calls).toEqual(["own u-1 +15555550100", "autolink u-1"]);
  });

  it("the job START time is saved, not the finish time (R6)", async () => {
    const d = deps();
    await handleCacheJobEnded(
      { kind: "cache", userId: "u-1", snapshot: { state: "finished", createdAt: "2026-10-01T11:00:00.000Z" }, detectedOwnNumber: null },
      d.deps,
    );
    expect(d.calls[0]).toBe("finished u-1 2026-10-01T11:00:00.000Z");
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

describe("button status for the page (R7)", () => {
  it.each([
    [{ ok: true as const, userId: "u-1" }, { ready: true }],
    [{ status: 403, error: "signed_out", message: "x" }, { ready: false, reason: "signed_out" }],
    [{ status: 403, error: "not_opted_in", message: "x" }, { ready: false, reason: "not_opted_in" }],
    [{ status: 503, error: "busy", message: "x" }, { ready: false, reason: "busy" }],
    [{ status: 409, error: "already_syncing", message: "x" }, { ready: false, reason: "busy" }],
  ])("%j → %j (no user data)", (decision, expected) => {
    expect(cacheStatusFrom(decision)).toEqual(expected);
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
