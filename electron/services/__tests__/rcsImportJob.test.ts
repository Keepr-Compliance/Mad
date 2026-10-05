/**
 * @jest-environment node
 */
/**
 * BACKLOG-3620 / 3658 — the Sync job's state. Since 2026-10-05 (founder) the
 * cache job is the only kind: the per-transaction Sync and its contact gate
 * were removed ("we can always add it again later").
 */

import {
  parseNotReached,
  participantKey,
  RCS_NOT_REACHED_CAP,
  RCS_JOB_NOT_OPENED_MESSAGE,
  RCS_JOB_UNCLAIMED_MS,
  RcsJobRegistry,
} from "../rcsImportJob";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jobModule = require("../rcsImportJob") as Record<string, unknown>;

const SINCE = "2026-08-01T00:00:00.000Z";

function registry(start = 1_000_000) {
  const clock = { now: start };
  return { clock, jobs: new RcsJobRegistry(() => clock.now) };
}

// Founder (2026-10-05). Mutation: the transaction job (or its contact gate)
// back → red.
describe("only the cache job exists", () => {
  it("no transaction job: no create(), no contact matcher; every job is kind cache", () => {
    const { jobs } = registry();
    expect((jobs as unknown as Record<string, unknown>).create).toBeUndefined();
    expect(jobModule.phonesMatchExactly).toBeUndefined();
    const job = jobs.createCache("u-1", SINCE);
    expect(job.kind).toBe("cache");
    const snap = job.snapshot() as unknown as Record<string, unknown>;
    expect(snap.kind).toBe("cache");
    expect(snap).not.toHaveProperty("transactionId");
    expect(snap).not.toHaveProperty("contactsWithoutPhone");
  });
});

describe("RcsImportJob / RcsJobRegistry", () => {
  it("claims once: no names, no numbers", () => {
    const { jobs } = registry();
    const job = jobs.createCache("u-1", SINCE);
    const claim = job.claim(jobs.nowMs());
    expect(claim).toEqual({ jobId: job.jobId, kind: "cache", startDate: SINCE, since: SINCE });
    expect(claim).not.toHaveProperty("contacts");
    expect(job.claim(jobs.nowMs())).toMatchObject({ status: 409, error: "already_running" });
  });

  it("a missing or unparseable floor is null (no date floor)", () => {
    const claimWith = (since: string) => {
      const { jobs } = registry();
      return jobs.createCache("u-1", since).claim(jobs.nowMs());
    };
    expect(claimWith("2026-03-01")).toMatchObject({ startDate: "2026-03-01" });
    expect(claimWith("")).toMatchObject({ startDate: null });
    expect(claimWith("not a date")).toMatchObject({ startDate: null });
  });

  it("an unclaimed job fails after the time limit with an explicit message", () => {
    const { clock, jobs } = registry();
    const job = jobs.createCache("u-1", SINCE);
    clock.now += RCS_JOB_UNCLAIMED_MS - 1;
    expect(jobs.pending()?.jobId).toBe(job.jobId);
    clock.now += 1;
    expect(jobs.pending()).toBeNull();
    expect(job.snapshot()).toMatchObject({ state: "failed", error: { code: "not_opened", message: RCS_JOB_NOT_OPENED_MESSAGE } });
    expect(job.claim(clock.now)).toMatchObject({ status: 410 });
  });

  it("check() refuses a wrong id (404) and an ended job (410)", () => {
    const { jobs } = registry();
    const job = jobs.createCache("u-1", SINCE);
    expect(jobs.check("00000000-0000-4000-8000-000000000000")).toMatchObject({ ok: false, status: 404 }); // pii-allow-uuid: invented, not from any live row
    expect(jobs.check(job.jobId)).toMatchObject({ ok: true });
    job.finish(jobs.nowMs());
    expect(jobs.check(job.jobId)).toMatchObject({ ok: false, status: 410 });
  });

  // BACKLOG-3661. Mutation: replace (or cancel) the running job again → red.
  it("one Sync at a time: while a job is created or running, createCache returns THAT job, untouched", () => {
    const { jobs } = registry();
    const first = jobs.createCache("u-1", SINCE);
    expect(jobs.createCache("u-1", SINCE)).toBe(first);
    first.claim(jobs.nowMs());
    expect(jobs.createCache("u-1", SINCE)).toBe(first);
    expect(first.state).toBe("running");
    expect(jobs.active()).toBe(first);
    expect(first.snapshot()).toMatchObject({ kind: "cache", label: "all Android texts" });
  });

  it("after the job ends a new one is created", () => {
    const { jobs } = registry();
    const first = jobs.createCache("u-1", SINCE);
    first.cancel(jobs.nowMs());
    expect(jobs.active()).toBeNull();
    const second = jobs.createCache("u-1", SINCE);
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
    const job = jobs.createCache("u-1", SINCE);
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
    const job = jobs.createCache("u-1", SINCE);
    job.claim(jobs.nowMs());
    job.match("chat-1", ["(555) 555-0199", "(555) 555-0100"]);
    expect(job.numbersFor("chat-1")).toEqual(["+15555550100", "+15555550199"]);
    job.match("chat-2", ["(555) 555-0142", "(555) 555-0100"]);
    expect(job.numbersFor("chat-1")).toEqual(["+15555550199"]);
    expect(job.numbersFor("chat-2")).toEqual(["+15555550142"]);
  });

  it("a person alone in a 1:1 chat and also in a group is never dropped", () => {
    const { jobs } = registry();
    const job = jobs.createCache("u-1", SINCE);
    job.claim(jobs.nowMs());
    job.match("one-to-one", ["(555) 555-0199"]);
    job.match("group", ["(555) 555-0199", "(555) 555-0142"]);
    expect(job.numbersFor("one-to-one")).toEqual(["+15555550199"]);
    expect(job.numbersFor("group")).toEqual(["+15555550142", "+15555550199"]);
  });
});

// BACKLOG-3658 — the cache job. Mutations: the claim losing since; a chat
// without a number counted as matched; the stored own number not used for
// the first chat; an own number remembered from fewer than 3 chats → red.
describe("the cache job (BACKLOG-3658)", () => {
  // SR (2026-10-02): the claim carries the deal chats to look for (ids) and
  // the oldest deal start (the list scan's limit) — both or neither, at most
  // 300 ids. Mutations: ids without the floor → red; no cap → red.
  it("the claim: deal chats and their oldest start, both or neither", () => {
    const { jobs } = registry();
    const ids = Array.from({ length: 320 }, (_, i) => "d-" + i);
    const cache = jobs.createCache("u-1", SINCE, [], false, {
      dealConversationIds: ids, dealFloorISO: "2026-01-10T00:00:00.000Z",
    });
    const claim = cache.claim(jobs.nowMs()) as Record<string, unknown>;
    expect(claim.dealFloor).toBe("2026-01-10T00:00:00.000Z");
    expect(claim.dealConversationIds).toEqual(ids.slice(0, 300));
    cache.cancel(jobs.nowMs());
    const noFloor = jobs.createCache("u-1", SINCE, [], false, { dealConversationIds: ["d-1"], dealFloorISO: null });
    const c2 = noFloor.claim(jobs.nowMs()) as Record<string, unknown>;
    expect(c2).not.toHaveProperty("dealConversationIds");
    expect(c2).not.toHaveProperty("dealFloor");
  });

  it("every chat with a number is kept (no contact gate); a chat without one is not", () => {
    const { jobs } = registry();
    const cache = jobs.createCache("u-1", SINCE);
    cache.claim(jobs.nowMs());
    cache.match("c-1", ["(555) 555-0142"]);
    cache.match("c-2", ["not a number"]);
    expect(cache.isMatched("c-1")).toBe(true);
    expect(cache.isMatched("c-2")).toBe(false);
    expect(cache.numbersFor("c-1")).toEqual(["+15555550142"]);
    expect(cache.numbersFor("conv-unknown")).toEqual([]);
    expect(cache.progress).toMatchObject({ checked: 2, matched: 1 });
  });

  it("the stored own number is left out of the FIRST chat already", () => {
    const { jobs } = registry();
    const cache = jobs.createCache("u-1", SINCE, ["(555) 555-0100"]);
    cache.claim(jobs.nowMs());
    cache.match("c-1", ["(555) 555-0142", "(555) 555-0100"]);
    expect(cache.numbersFor("c-1")).toEqual(["+15555550142"]);
  });

  it("an own number is only remembered when 3+ chats agree on exactly one", () => {
    const { jobs } = registry();
    const cache = jobs.createCache("u-1", SINCE);
    cache.claim(jobs.nowMs());
    cache.match("c-1", ["(555) 555-0142", "(555) 555-0100"]);
    cache.match("c-2", ["(555) 555-0199", "(555) 555-0100"]);
    expect(cache.detectedOwnNumber()).toBeNull();
    cache.match("c-3", ["(555) 555-0123", "(555) 555-0100"]);
    expect(cache.detectedOwnNumber()).toBe("+15555550100");
  });

  it("the job remembers its user", () => {
    const { jobs } = registry();
    expect(jobs.createCache("u-9", SINCE).userId).toBe("u-9");
  });
});

// BACKLOG-3658 P3b: the contacts-only flag (off by default). Mutation: the
// filter ignored in match() → red.
describe("cache job: the contacts-only filter", () => {
  it("keeps only the chats the filter allows; without it, every chat with a number", () => {
    const registry = new RcsJobRegistry();
    const job = registry.createCache("user-1", SINCE, []);
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
