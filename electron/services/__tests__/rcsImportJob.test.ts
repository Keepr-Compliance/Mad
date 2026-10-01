/**
 * @jest-environment node
 */
/**
 * BACKLOG-3620 — the Sync job's state and the phone gate.
 *
 * Control 2: the gate is exact E.164 equality; a foreign number that shares the
 *            last ten digits with a contact's US number does NOT match.
 */

import {
  parseNotReached,
  participantKey,
  phonesMatchExactly,
  RCS_NOT_REACHED_CAP,
  RCS_JOB_NOT_OPENED_MESSAGE,
  RCS_JOB_UNCLAIMED_MS,
  RcsJobRegistry,
  type RcsJobContact,
} from "../rcsImportJob";

const CONTACTS: RcsJobContact[] = [
  { contactId: "c-1", displayName: "Test Contact A", phonesE164: ["+15555550199"] },
  { contactId: "c-2", displayName: "Test Contact B", phonesE164: ["+15555550100", "+15555550101"] },
  { contactId: "c-3", displayName: "Test Contact C", phonesE164: [] },
];

function registry(start = 1_000_000) {
  const clock = { now: start };
  return { clock, jobs: new RcsJobRegistry(() => clock.now) };
}

describe("phonesMatchExactly (control 2)", () => {
  it.each([
    ["(555) 555-0199", "+15555550199", true],
    ["+1 555-555-0199", "+15555550199", true],
    ["555.555.0199", "+15555550199", true],
    ["(555) 555-0198", "+15555550199", false],
    // Same last ten digits, different country: must NOT match.
    ["+44 555 555 0199", "+15555550199", false],
    ["+445555550199", "+15555550199", false],
    ["", "+15555550199", false],
    ["someone@example.com", "someone@example.com", false],
  ])("%s vs %s -> %s", (shown, own, expected) => {
    expect(phonesMatchExactly(shown, own)).toBe(expected);
  });

  it("a job does not match a chat whose only number is foreign with the same ten digits", () => {
    const { jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    job.claim(jobs.nowMs());
    expect(job.match("conv-x", ["+445555550199"])).toEqual([]);
    expect(job.isMatched("conv-x")).toBe(false);
  });
});

describe("RcsImportJob / RcsJobRegistry", () => {
  it("claims once, returning names only (never numbers), and skips contacts with no phone", () => {
    const { jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    const claim = job.claim(jobs.nowMs());
    expect(claim).toEqual({
      jobId: job.jobId,
      contacts: [
        { contactId: "c-1", displayName: "Test Contact A" },
        { contactId: "c-2", displayName: "Test Contact B" },
      ],
      startDate: null,
      // BACKLOG-3641 / SR B1: a COUNT only — Keepr-only names never reach the page.
      contactsWithoutPhoneCount: 1,
    });
    expect(JSON.stringify(claim)).not.toContain("+1");
    // SR B1. Mutation: send the no-phone contacts' names again → red.
    expect(JSON.stringify(claim)).not.toContain("Test Contact C");
    expect(job.claim(jobs.nowMs())).toMatchObject({ status: 409, error: "already_running" });
  });

  it("the claim carries the transaction's start date; a missing or unparseable one is null (no date floor)", () => {
    // A fresh registry per case: one Sync at a time (BACKLOG-3661).
    const claimWith = (startDate: string | null) => {
      const { jobs } = registry();
      return jobs.create("tx-1", CONTACTS, startDate).claim(jobs.nowMs());
    };
    expect(claimWith("2026-03-01")).toMatchObject({ startDate: "2026-03-01" });
    expect(claimWith("2026-03-01T00:00:00.000Z")).toMatchObject({ startDate: "2026-03-01T00:00:00.000Z" });
    expect(claimWith(null)).toMatchObject({ startDate: null });
    expect(claimWith("")).toMatchObject({ startDate: null });
    expect(claimWith("not a date")).toMatchObject({ startDate: null });
  });

  it("reports contacts that have no phone number", () => {
    const { jobs } = registry();
    expect(jobs.create("tx-1", CONTACTS).snapshot().contactsWithoutPhone).toEqual(["Test Contact C"]);
  });

  it("matches a group chat when ANY participant matches, and records the conversation", () => {
    const { jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    job.claim(jobs.nowMs());
    expect(job.match("conv-1", ["(555) 555-0150", "(555) 555-0101"])).toEqual(["c-2"]);
    expect(job.isMatched("conv-1")).toBe(true);
    expect(job.progress).toMatchObject({ checked: 1, matched: 1 });
  });

  it("an unclaimed job fails after the time limit with an explicit message", () => {
    const { clock, jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    clock.now += RCS_JOB_UNCLAIMED_MS - 1;
    expect(jobs.pending()?.jobId).toBe(job.jobId);
    clock.now += 1;
    expect(jobs.pending()).toBeNull();
    expect(job.snapshot()).toMatchObject({ state: "failed", error: { code: "not_opened", message: RCS_JOB_NOT_OPENED_MESSAGE } });
    expect(job.claim(clock.now)).toMatchObject({ status: 410 });
  });

  it("check() refuses a wrong id (404) and an ended job (410)", () => {
    const { jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    expect(jobs.check("00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, status: 404 }); // pii-allow-uuid: invented, not from any live row
    expect(jobs.check(job.jobId)).toMatchObject({ ok: true });
    job.finish(jobs.nowMs());
    expect(jobs.check(job.jobId)).toMatchObject({ ok: false, status: 410 });
  });

  // BACKLOG-3661. Mutation: replace (or cancel) the running job again → red.
  it("one Sync at a time: while a job is created or running, create returns THAT job, untouched", () => {
    const { jobs } = registry();
    const first = jobs.create("tx-1", CONTACTS, null, "1 Test Street");
    expect(jobs.create("tx-2", CONTACTS)).toBe(first);
    first.claim(jobs.nowMs());
    expect(jobs.create("tx-2", CONTACTS)).toBe(first);
    expect(first.state).toBe("running");
    expect(jobs.check(first.jobId)).toMatchObject({ ok: true });
    expect(jobs.active()).toBe(first);
    expect(first.snapshot().label).toBe("1 Test Street");
  });

  it("after the job ends (finished, failed or cancelled) a new one is created", () => {
    const { jobs } = registry();
    const first = jobs.create("tx-1", CONTACTS);
    first.cancel(jobs.nowMs());
    expect(jobs.active()).toBeNull();
    const second = jobs.create("tx-2", CONTACTS);
    expect(second).not.toBe(first);
    expect(jobs.check(first.jobId)).toMatchObject({ ok: false, status: 404 });
    expect(jobs.check(second.jobId)).toMatchObject({ ok: true });
  });
});

// BACKLOG-3629. Mutations that turn these red: drop the `entries.length >=
// RCS_NOT_REACHED_CAP` branch (21 entries kept), or ignore the page's own
// "more" count.
describe("parseNotReached (the page's /finish list)", () => {
  it("keeps well-formed entries up to the cap and counts the rest", () => {
    const list = [
      { name: "Chat A", reason: "not_opened" },
      { name: 42, reason: "bad" },
      "junk",
      { name: "Chat B", reason: "images_failed", count: 3.7 },
      ...Array.from({ length: RCS_NOT_REACHED_CAP }, (_, i) => ({ name: `Chat ${i}`, reason: "error" })),
    ];
    const parsed = parseNotReached(list, 4);
    expect(parsed.entries).toHaveLength(RCS_NOT_REACHED_CAP);
    expect(parsed.entries[0]).toEqual({ name: "Chat A", reason: "not_opened" });
    expect(parsed.entries[1]).toEqual({ name: "Chat B", reason: "images_failed", count: 3 });
    expect(parsed.more).toBe(4 + 2);
  });

  it("anything but an array is no entries; a bad 'more' is 0", () => {
    expect(parseNotReached(undefined, "x")).toEqual({ entries: [], more: 0 });
    expect(parseNotReached({ name: "a" }, -1)).toEqual({ entries: [], more: 0 });
  });

  it("finish() puts the entries on the snapshot", () => {
    const { jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    job.claim(jobs.nowMs());
    job.finish(jobs.nowMs(), { entries: [{ name: "Chat A", reason: "no_numbers" }], more: 0 });
    expect(job.snapshot()).toMatchObject({ state: "finished", notReached: [{ name: "Chat A", reason: "no_numbers" }], notReachedMore: 0 });
  });
});

// BACKLOG-3642. Mutations: unsorted key, or a key that keeps unnormalized
// numbers → red.
describe("participantKey (re-pair-proof chat identity)", () => {
  it("sorted, de-duplicated E.164; formatting does not matter; non-numbers dropped", () => {
    expect(participantKey(["(555) 555-0199", "+1 555 555 0100", "555-555-0199"])).toBe("+15555550100,+15555550199");
    expect(participantKey(["+1 555 555 0100", "(555) 555-0199"])).toBe(participantKey(["(555) 555-0199", "+15555550100"]));
    expect(participantKey(["someone@example.test", ""])).toBe("");
  });

  // SR optional own-number fallback. Mutations: drop the "2+ chats" or the
  // "2+ numbers each" condition → red.
  it("a number shown in every checked chat (each with 2+ numbers) is treated as the user's own", () => {
    const { jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    job.claim(jobs.nowMs());
    job.match("chat-1", ["(555) 555-0199", "(555) 555-0100"]);
    // One chat only: no evidence yet.
    expect(job.numbersFor("chat-1")).toEqual(["+15555550100", "+15555550199"]);
    job.match("chat-2", ["(555) 555-0142", "(555) 555-0100"]);
    expect(job.numbersFor("chat-1")).toEqual(["+15555550199"]);
    expect(job.numbersFor("chat-2")).toEqual(["+15555550142"]);
  });

  it("a contact alone in a 1:1 chat and also in a group is never dropped", () => {
    const { jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    job.claim(jobs.nowMs());
    job.match("one-to-one", ["(555) 555-0199"]);
    job.match("group", ["(555) 555-0199", "(555) 555-0142"]);
    expect(job.numbersFor("one-to-one")).toEqual(["+15555550199"]);
    expect(job.numbersFor("group")).toEqual(["+15555550142", "+15555550199"]);
  });

  it("the job remembers the numbers of each chat it matched (BACKLOG-3630)", () => {
    const { jobs } = registry();
    const job = jobs.create("tx-1", CONTACTS);
    job.claim(jobs.nowMs());
    job.match("conv-1", ["(555) 555-0199"]);
    expect(job.numbersFor("conv-1")).toEqual(["+15555550199"]);
    expect(job.numbersFor("conv-unknown")).toEqual([]);
  });
});

// BACKLOG-3658 — the cache job. Mutations: a cache job replacing a running
// one; the claim keeping contacts / losing since; a chat without a number
// counted as matched; the stored own number not used for the first chat; an
// own number remembered from fewer than 3 chats → red.
describe("the cache job (BACKLOG-3658)", () => {
  it("one slot: no cache job while a Sync runs, and none of either kind while it runs", () => {
    const { jobs } = registry();
    const tx = jobs.create("tx-1", CONTACTS);
    expect(jobs.createCache("u-1", "2026-08-01T00:00:00.000Z")).toBe(tx);
    tx.cancel(jobs.nowMs());
    const cache = jobs.createCache("u-1", "2026-08-01T00:00:00.000Z");
    expect(cache.kind).toBe("cache");
    expect(jobs.create("tx-2", CONTACTS)).toBe(cache);
    expect(cache.snapshot()).toMatchObject({ kind: "cache", label: "all Android texts", transactionId: "" });
  });

  it("the claim: no contacts, kind cache, history back to since", () => {
    const { jobs } = registry();
    const cache = jobs.createCache("u-1", "2026-08-01T00:00:00.000Z");
    expect(cache.claim(jobs.nowMs())).toEqual({
      jobId: cache.jobId,
      kind: "cache",
      contacts: [],
      startDate: "2026-08-01T00:00:00.000Z",
      since: "2026-08-01T00:00:00.000Z",
      contactsWithoutPhoneCount: 0,
    });
  });

  it("every chat with a number is kept (no contact gate); a chat without one is not", () => {
    const { jobs } = registry();
    const cache = jobs.createCache("u-1", "2026-08-01T00:00:00.000Z");
    cache.claim(jobs.nowMs());
    cache.match("c-1", ["(555) 555-0142"]);
    cache.match("c-2", ["not a number"]);
    expect(cache.isMatched("c-1")).toBe(true);
    expect(cache.isMatched("c-2")).toBe(false);
    expect(cache.numbersFor("c-1")).toEqual(["+15555550142"]);
    expect(cache.progress).toMatchObject({ checked: 2, matched: 1 });
  });

  it("the stored own number is left out of the FIRST chat already", () => {
    const { jobs } = registry();
    const cache = jobs.createCache("u-1", "2026-08-01T00:00:00.000Z", ["(555) 555-0100"]);
    cache.claim(jobs.nowMs());
    cache.match("c-1", ["(555) 555-0142", "(555) 555-0100"]);
    expect(cache.numbersFor("c-1")).toEqual(["+15555550142"]);
  });

  it("an own number is only remembered when 3+ chats agree on exactly one", () => {
    const { jobs } = registry();
    const cache = jobs.createCache("u-1", "2026-08-01T00:00:00.000Z");
    cache.claim(jobs.nowMs());
    cache.match("c-1", ["(555) 555-0142", "(555) 555-0100"]);
    cache.match("c-2", ["(555) 555-0199", "(555) 555-0100"]);
    expect(cache.detectedOwnNumber()).toBeNull();
    cache.match("c-3", ["(555) 555-0123", "(555) 555-0100"]);
    expect(cache.detectedOwnNumber()).toBe("+15555550100");
  });

  it("transaction jobs remember their user too", () => {
    const { jobs } = registry();
    expect(jobs.create("tx-1", CONTACTS, null, null, "u-9").userId).toBe("u-9");
  });
});

// BACKLOG-3658 P3b: the contacts-only flag (off by default). Mutation: the
// filter ignored in match() → red.
describe("cache job: the contacts-only filter", () => {
  it("keeps only the chats the filter allows; without it, every chat with a number", () => {
    const registry = new RcsJobRegistry();
    const job = registry.createCache("user-1", "2026-08-01T00:00:00.000Z", []);
    job.claim(Date.now());
    job.match("conv-a", ["+15555550101"], (n) => n.includes("+15555550101"));
    job.match("conv-b", ["+15555550102"], (n) => n.includes("+15555550101"));
    job.match("conv-c", ["+15555550103"]);
    expect(job.isMatched("conv-a")).toBe(true);
    expect(job.isMatched("conv-b")).toBe(false);
    expect(job.isMatched("conv-c")).toBe(true);
    expect(job.progress.checked).toBe(3);
    expect(job.progress.matched).toBe(2);
  });
});
