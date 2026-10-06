/**
 * @jest-environment node
 */
/**
 * BACKLOG-3658 — the cache job's rules (pure).
 *
 * Mutation controls (each turns a test red):
 *   R1 since without the max (always 60 days, or always last − 1 day) → "since"
 *   R2 a refusal skipped (signed out / no current consent / busy / running) → "who may start"
 *   K1 (P3b) an old consent version accepted                            → "who may start"
 *   K2 (P3b) Keepr's version and the text's version drift apart          → "the consent text"
 *   K3 (P3b) the auto-delete run before the auto-link, or not at all      → "finished: committed"
 *   R3 the finish time saved after a cancel or an error                 → "saved only on success"
 *   R4 a cancel (user Stop) commits / links / keeps staging, or a failure  → "cancelled (the user's Stop)" / "failed: the finished chats"
 *      discards its finished chats (3671 P3)
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
 *   W5 max-messages applied to the cache, or the audit spans lost        → "cacheWindow: limits"
 *   V8 (3663) a widened floor read only incrementally (older never read)  → "reading older texts"
 *   V9 (3663) coverage recorded for a capped / partial / incremental run  → "cacheRunReachedFloor"
 */

import {
  cacheSince,
  backfillCoverageFrom,
  cacheRunCoverage,
  cacheRunReachedFloor,
  cacheRunReadNothing,
  cacheWindow,
  chatFloorDecision,
  clampSinceDays,
  effectiveChatCoverageMs,
  pickDealChats,
  settingsStartISO,
  cancelOnSessionChange,
  cacheSavedFromCommit,
  consentToRecordOnSync,
  decideCacheStart,
  shouldFocusKeeprOnJobEnd,
  handleCacheJobEnded,
  RCS_CACHE_WINDOW_DAYS,
  RCS_CONSENT_REQUIRED,
  RCS_CONSENT_VERSION,
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

// Founder (2026-10-01): the done screens show what Keepr SAVED. Mutation:
// staged/kept counts used instead → red.
describe("cacheSavedFromCommit", () => {
  it("saved chats = chats stored (all-below-floor chats are not), messages = new + already there", () => {
    expect(
      cacheSavedFromCommit({
        staged: 328, kept: 212, droppedByDate: 116, droppedByCap: 0, chats: 9, stored: 200, alreadyPresent: 12,
        imagesStaged: 0, imagesStored: 0, reactions: 7,
      }),
    ).toEqual({ chats: 9, messages: 212, newMessages: 200, reactions: 7, newReactions: 7, photos: 0 });
  });

  // Storyboard A10 / A11: "… · 64 photos" — photos in Keepr for this Sync
  // (stored now + already there). Mutation: only the new ones → red.
  it("photos = images stored + already there", () => {
    expect(
      cacheSavedFromCommit({
        staged: 10, kept: 10, droppedByDate: 0, droppedByCap: 0, chats: 2, stored: 10, alreadyPresent: 0,
        imagesStaged: 64, imagesStored: 60, imagesAlreadyThere: 4, reactions: 0,
      }).photos,
    ).toBe(64);
  });

  // Live (0.3.18): reactions read like messages — all saved, then how many new.
  // Mutation: reactions = new rows only again → red.
  it("reactions: every saved reaction, and how many are new", () => {
    expect(
      cacheSavedFromCommit({
        staged: 244, kept: 244, droppedByDate: 0, droppedByCap: 0, chats: 11, stored: 0, alreadyPresent: 244,
        imagesStaged: 4, imagesStored: 0, reactions: 0, reactionsKept: 52, imagesAlreadyThere: 4, imagesNoMessage: 0,
      }),
    ).toMatchObject({ messages: 244, newMessages: 0, reactions: 52, newReactions: 0 });
  });
});

describe("shouldFocusKeeprOnJobEnd", () => {
  it("done or failed: yes; cancelled (or still running): no", () => {
    expect(shouldFocusKeeprOnJobEnd("finished")).toBe(true);
    expect(shouldFocusKeeprOnJobEnd("failed")).toBe(true);
    expect(shouldFocusKeeprOnJobEnd("cancelled")).toBe(false);
    expect(shouldFocusKeeprOnJobEnd("running")).toBe(false);
  });
});

describe("who may start a cache Sync (R2)", () => {
  const ok = { userId: "u-1", consentVersion: RCS_CONSENT_VERSION, activeLabel: null, writesPaused: false };
  it("signed in, consent current, nothing running: yes", () => {
    expect(decideCacheStart(ok)).toEqual({ ok: true, userId: "u-1" });
  });
  it("signed out: 403", () => {
    expect(decideCacheStart({ ...ok, userId: null })).toMatchObject({ status: 403, error: "signed_out" });
  });
  it("consent required: no consent, or an older consent text → 403 consent_needed (K1)", () => {
    const req = { ...ok, consentRequired: true };
    expect(decideCacheStart({ ...req, consentVersion: null })).toMatchObject({ status: 403, error: "consent_needed" });
    expect(decideCacheStart({ ...req, consentVersion: undefined })).toMatchObject({ status: 403, error: "consent_needed" });
    expect(decideCacheStart({ ...req, consentVersion: RCS_CONSENT_VERSION - 1 })).toMatchObject({ status: 403, error: "consent_needed" });
    expect(decideCacheStart(req)).toEqual({ ok: true, userId: "u-1" });
  });
  // SR C7 (founder, 2026-10-04): consent required (the shipped default) —
  // no current consent → consent_needed. Mutation: the gate off → red.
  it("consent required (the shipped default): no current consent → consent_needed (K2)", () => {
    expect(RCS_CONSENT_REQUIRED).toBe(true);
    expect(decideCacheStart({ ...ok, consentVersion: null })).toMatchObject({ status: 403, error: "consent_needed" });
    expect(decideCacheStart({ ...ok, consentVersion: RCS_CONSENT_VERSION - 1 })).toMatchObject({ error: "consent_needed" });
    expect(decideCacheStart({ ...ok, consentVersion: RCS_CONSENT_VERSION })).toEqual({ ok: true, userId: "u-1" });
    expect(decideCacheStart({ ...ok, consentVersion: null, consentRequired: false })).toEqual({ ok: true, userId: "u-1" });
  });
  it("the Sync never records consent while it is required (the modal does); off, the first Sync would (K3)", () => {
    expect(consentToRecordOnSync(null)).toBeNull();
    expect(consentToRecordOnSync(null, false)).toBe(RCS_CONSENT_VERSION);
    expect(consentToRecordOnSync(RCS_CONSENT_VERSION, false)).toBeNull();
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
        afterLink: async (u: string) => {
          calls.push(`afterlink ${u}`);
        },
        onSaved: (u: string) => void calls.push(`saved ${u}`),
        now: () => NOW,
      },
    };
  }
  const ended = (state: string, kind = "cache", own: string | null = null) => ({
    kind, userId: "u-1", snapshot: { state, jobId: "job-1" }, detectedOwnNumber: own,
  });

  // Live (founder, 2026-10-05): a "finished" run that saved nothing while
  // every chat it checked came back empty read NOTHING — "last synced" must
  // not move (the next Sync would skip chats active before it). Mutation:
  // the time saved anyway → red.
  it("finished but read nothing (every chat empty, 0 imported): no time saved", async () => {
    const d = deps();
    await handleCacheJobEnded(
      { kind: "cache", userId: "u-1", snapshot: { state: "finished", jobId: "job-1", progress: { imported: 0, matched: 3, noMessagesYet: 3 } }, detectedOwnNumber: null },
      d.deps,
    );
    expect(d.calls.some((c) => c.startsWith("finished "))).toBe(false);
    expect(cacheRunReadNothing({ state: "finished", jobId: "j", progress: { imported: 0, matched: 3, noMessagesYet: 3 } })).toBe(true);
    // A real run: something saved, or a chat that was not empty.
    expect(cacheRunReadNothing({ state: "finished", jobId: "j", progress: { imported: 2, matched: 3, noMessagesYet: 1 } })).toBe(false);
    expect(cacheRunReadNothing({ state: "finished", jobId: "j", progress: { imported: 0, matched: 3, noMessagesYet: 1 } })).toBe(false);
    expect(cacheRunReadNothing({ state: "finished", jobId: "j", progress: { imported: 0, matched: 0, noMessagesYet: 0 } })).toBe(false);
    // Never "reached the floor".
    expect(cacheRunReachedFloor(true, { state: "finished", jobId: "j", listStop: "stable", progress: { imported: 0, matched: 3, noMessagesYet: 3 } })).toBe(false);
  });

  it("finished: committed (one transaction), then the time is saved, then the auto-link for that user", async () => {
    const d = deps();
    await handleCacheJobEnded(ended("finished"), d.deps);
    expect(d.calls).toEqual(["commit job-1 u-1", `finished u-1 ${new Date(NOW).toISOString()}`, "autolink u-1", "afterlink u-1", "saved u-1"]);
  });

  // 3671 P3 (founder): the user's STOP (a cancel) commits NOTHING; a real
  // failure keeps the chats it finished, links them, and saves no time (the
  // next run is "Try again"). Mutations: a cancel committing → red; a failure
  // discarding → red; a failure saving the time → red.
  it("cancelled (the user's Stop): discard only — nothing committed, no time saved, no auto-link (R3, R4)", async () => {
    const d = deps();
    await handleCacheJobEnded(ended("cancelled"), d.deps);
    expect(d.calls).toEqual(["discard job-1"]);
  });

  it("failed: the finished chats are committed and linked; no time saved (R3, 3671 P3)", async () => {
    const d = deps();
    await handleCacheJobEnded(ended("failed"), d.deps);
    expect(d.calls).toEqual(["commit job-1 u-1", "autolink u-1", "afterlink u-1", "saved u-1"]);
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

  // Item 7: a cancel used to leave no log line. Mutation: no info line, or
  // one for a failed job / a finished one → red.
  it("cancelled: one INFO line with the job kind, chats done so far and staging rows discarded (L7)", async () => {
    const infos: string[] = [];
    const d = deps();
    await handleCacheJobEnded(
      { kind: "cache", userId: "u-1", snapshot: { state: "cancelled", jobId: "job-1", progress: { imported: 4 } }, detectedOwnNumber: null },
      { ...d.deps, discard: async () => 37, info: (m) => void infos.push(m) },
    );
    expect(infos).toEqual(["[RcsCache] Sync cancelled (job kind cache): 4 chats done so far, 37 staging rows discarded"]);
    for (const state of ["failed", "finished"]) {
      infos.length = 0;
      await handleCacheJobEnded(ended(state), { ...deps().deps, info: (m) => void infos.push(m) });
      expect([state, infos]).toEqual([state, []]);
    }
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
    const later = cacheWindow({
      nowMs: NOW, lastFinishedAt: "2026-09-30T08:00:00.000Z", plan: plan(threeMonths), isPackaged: true, coveredSince: threeMonths,
    });
    expect(later.readingOlder).toBe(false);
    expect(later.since).toBe("2026-09-29T08:00:00.000Z");
    expect(later.limits.floorMs).toBe(Date.parse(threeMonths));
    // All time: 3650 days at most.
    expect(cacheWindow({ nowMs: NOW, lastFinishedAt: null, plan: plan(null), isPackaged: true }).limits.floorMs)
      .toBe(NOW - 3650 * DAY);
  });

  // Founder (2026-10-01): date limit only for this source; a total cap later.
  // BACKLOG-3663: the months setting (or a deal's audit period) widened, or no
  // run reached its floor yet → the next Sync reads down to the floor again.
  it("reading older texts: only a floor older than what is covered (V8; L2: NULL coverage does not)", () => {
    const base = { nowMs: NOW, lastFinishedAt: "2026-09-30T08:00:00.000Z", plan: plan(threeMonths), isPackaged: true };
    const widened = cacheWindow({ ...base, coveredSince: "2026-08-01T00:00:00.000Z" });
    expect(widened).toMatchObject({ since: threeMonths, readingOlder: true });
    // L2 (live: every Sync re-read everything). Mutation: NULL forcing a full read → red.
    const neverReached = cacheWindow({ ...base, coveredSince: null });
    expect(neverReached.readingOlder).toBe(false);
    expect(neverReached.since).toBe("2026-09-29T08:00:00.000Z"); // incremental: last finished − 1 day
    // The very first run reads to the floor anyway, but it is not "older".
    expect(cacheWindow({ ...base, lastFinishedAt: null, coveredSince: null })).toMatchObject({ since: threeMonths, readingOlder: false });
  });

  it("cacheRunReachedFloor: a full, finished read of every chat only (V9)", () => {
    const done = { state: "finished", jobId: "j", progress: { notChecked: 0 }, notReached: [{ reason: "no_numbers" }], notReachedMore: 0, listStop: "since" };
    expect(cacheRunReachedFloor(true, done)).toBe(true);
    expect(cacheRunReachedFloor(false, done)).toBe(false); // incremental
    expect(cacheRunReachedFloor(true, { ...done, progress: { notChecked: 3 } })).toBe(false); // over the 300 cap
    expect(cacheRunReachedFloor(true, { ...done, notReached: [{ reason: "history_truncated" }] })).toBe(false);
    // L2: a not-settled chat no longer blocks the coverage — it is counted.
    expect(cacheRunReachedFloor(true, { ...done, notReached: [{ reason: "history_not_settled" }] })).toBe(true);
    expect(cacheRunCoverage(true, { ...done, notReached: [{ reason: "history_not_settled", name: "A" }, { reason: "history_not_settled", name: "B" }] }))
      .toEqual({ reached: true, notSettledChats: 2 });
    // L2: only a normal list stop (since | stable) records it.
    expect(cacheRunReachedFloor(true, { ...done, listStop: "max_time" })).toBe(false);
    expect(cacheRunReachedFloor(true, { ...done, listStop: "max_items" })).toBe(false);
    expect(cacheRunReachedFloor(true, { ...done, listStop: undefined })).toBe(false);
    expect(cacheRunReachedFloor(true, { ...done, listStop: "stable" })).toBe(true);
    // #10 gap guard: an unrecovered gap blocks it.
    expect(cacheRunReachedFloor(true, { ...done, notReached: [{ reason: "history_gap" }] })).toBe(false);
    expect(cacheRunReachedFloor(true, { ...done, notReachedMore: 1 })).toBe(false);
    expect(cacheRunReachedFloor(true, { ...done, state: "cancelled" })).toBe(false);
  });

  // L2: backfill only from a full, normally-stopped run that reached its floor.
  // Mutation: backfill from any run → red.
  it("backfillCoverageFrom: the previous run's floor only for a full read with a normal list stop", () => {
    const ok = { floorISO: "2026-07-01T00:00:00.000Z", fullRead: true, listStop: "since", reachedFloor: true };
    expect(backfillCoverageFrom(ok)).toBe("2026-07-01T00:00:00.000Z");
    expect(backfillCoverageFrom({ ...ok, listStop: "max_time" })).toBeNull();
    expect(backfillCoverageFrom({ ...ok, listStop: "max_items" })).toBeNull();
    expect(backfillCoverageFrom({ ...ok, fullRead: false })).toBeNull();
    expect(backfillCoverageFrom({ ...ok, reachedFloor: false })).toBeNull();
    expect(backfillCoverageFrom(null)).toBeNull();
  });

  it("limits: the date floor only — max messages NOT applied; the audit periods (Apple-epoch ns → ms) kept (W5)", () => {
    const startMs = Date.parse("2026-05-01T00:00:00.000Z");
    const nano = (ms: number) => (ms - 978307200000) * 1_000_000;
    const w = cacheWindow({
      nowMs: NOW, lastFinishedAt: null, isPackaged: true,
      plan: { fetchStartISO: threeMonths, effectiveCap: 1000, protectedSpans: [{ startNano: nano(startMs), endNano: null }] },
    });
    expect(w.limits.cap).toBeNull();
    expect(w.limits.protectedSpans).toEqual([{ startMs, endMs: null }]);
  });

  // SR (2026-10-02): the job floor is the SETTINGS floor; a deal's audit
  // period widens only that deal's chats (/match floorMs). Mutations: the
  // plan's widened fetchStartISO used as the job floor → red; a deal span
  // setting the job-wide "reading older" → red.
  it("deal audit periods never widen the job floor or set reading older job-wide", () => {
    const january = "2026-01-10T00:00:00.000Z";
    const widenedPlan = {
      ...plan(january),
      overrides: [{ kind: "window-extended-by-deals", requestedStartISO: threeMonths, effectiveStartISO: january }],
    };
    expect(settingsStartISO(widenedPlan)).toBe(threeMonths);
    expect(settingsStartISO(plan(threeMonths))).toBe(threeMonths);
    const w = cacheWindow({
      nowMs: NOW, lastFinishedAt: "2026-09-30T08:00:00.000Z", plan: widenedPlan, isPackaged: true, coveredSince: threeMonths,
    });
    expect(w.limits.floorMs).toBe(Date.parse(threeMonths));
    expect(w.readingOlder).toBe(false);
    expect(w.since).toBe("2026-09-29T08:00:00.000Z");
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

// SR (2026-10-02): one chat's floor. Mutations: no 3650-day clamp → red; no
// tolerance (a chat covered to within a day re-read) → red; a deal later than
// the settings floor widening → red; pickDealChats keeping a Don't-sync chat
// or ignoring max → red.
describe("chatFloorDecision / pickDealChats (per-chat widening)", () => {
  const settings = Date.parse("2026-08-15T00:00:00.000Z");
  const jan = Date.parse("2026-01-10T00:00:00.000Z");

  it("a deal older than the settings floor: the chat's floor is the deal's start; widen until covered", () => {
    expect(chatFloorDecision({ nowMs: NOW, settingsFloorMs: settings, dealStartMs: jan, coveredSinceMs: null }))
      .toEqual({ floorMs: jan, widen: true, widenDays: Math.round((settings - jan) / DAY) });
    expect(chatFloorDecision({ nowMs: NOW, settingsFloorMs: settings, dealStartMs: jan, coveredSinceMs: settings }).widen).toBe(true);
    // Covered to within a day of the deal's start: not read again.
    expect(chatFloorDecision({ nowMs: NOW, settingsFloorMs: settings, dealStartMs: jan, coveredSinceMs: jan + DAY - 1 }))
      .toMatchObject({ floorMs: jan, widen: false });
    expect(chatFloorDecision({ nowMs: NOW, settingsFloorMs: settings, dealStartMs: jan, coveredSinceMs: jan + DAY + 1 }).widen).toBe(true);
  });

  it("no deal, or a deal inside the settings window: the settings floor (null)", () => {
    expect(chatFloorDecision({ nowMs: NOW, settingsFloorMs: settings, dealStartMs: null, coveredSinceMs: null }).floorMs).toBeNull();
    expect(chatFloorDecision({ nowMs: NOW, settingsFloorMs: settings, dealStartMs: settings + DAY, coveredSinceMs: null }).floorMs).toBeNull();
    expect(chatFloorDecision({ nowMs: NOW, settingsFloorMs: settings, dealStartMs: settings, coveredSinceMs: null }).floorMs).toBeNull();
  });

  it("never more than 3650 days back", () => {
    expect(chatFloorDecision({ nowMs: NOW, settingsFloorMs: settings, dealStartMs: Date.parse("1990-01-01T00:00:00.000Z"), coveredSinceMs: null }).floorMs)
      .toBe(NOW - 3650 * DAY);
  });

  it("effective coverage: the earlier of the chat's own and the source's", () => {
    expect(effectiveChatCoverageMs("2026-01-10T00:00:00.000Z", "2026-08-15T00:00:00.000Z")).toBe(jan);
    expect(effectiveChatCoverageMs(null, "2026-08-15T00:00:00.000Z")).toBe(settings);
    expect(effectiveChatCoverageMs("2026-01-10T00:00:00.000Z", null)).toBe(jan);
    expect(effectiveChatCoverageMs(null, null)).toBeNull();
  });

  it("pickDealChats: not yet covered, not Don't-sync, oldest first, at most max", () => {
    const starts = new Map([["h-old", Date.parse("2025-12-01T00:00:00.000Z")], ["h-jan", jan], ["h-off", jan], ["h-done", jan], ["h-new", settings + DAY]]);
    const own = new Map([["h-done", "2026-01-10T00:00:00.000Z"]]);
    const picked = pickDealChats({
      nowMs: NOW, settingsFloorMs: settings, starts, own, sourceCoveredSince: "2026-08-15T00:00:00.000Z", excluded: new Set(["h-off"]), max: 300,
    });
    expect(picked.map((p) => p.chatHash)).toEqual(["h-old", "h-jan"]);
    expect(pickDealChats({ nowMs: NOW, settingsFloorMs: settings, starts, own, sourceCoveredSince: null, excluded: new Set(), max: 1 }))
      .toHaveLength(1);
  });
});
