/**
 * Tests for emailIndexHelpers (BACKLOG-2161).
 *
 * The export's "Email Threads Index" must group emails the SAME way the app
 * groups them on-screen ("N conversations"). These tests assert by exact ID SET
 * (per founder directive: same count with wrong IDs = false pass), and cover the
 * regression the fix hinges on: emails with no thread_id but a shared normalized
 * subject and DIFFERENT participants must collapse to ONE thread (the case where
 * the old participants-based getThreadKey would have split them).
 */

import type { Communication } from "../../../types/models";
import {
  normalizeEmailSubject,
  getEmailIndexThreadKey,
  groupEmailsForIndex,
  countEmailIndexThreads,
} from "../emailIndexHelpers";

/** Build a minimal email Communication for grouping tests. */
function email(
  id: string,
  fields: Partial<Communication> = {}
): Communication {
  return {
    id,
    user_id: "user-123",
    channel: "email",
    subject: "Subject",
    sender: "a@test.com",
    sent_at: "2026-01-01T00:00:00.000Z",
    ...fields,
  } as Communication;
}

/** The set of email IDs in each grouped thread, as a comparable structure. */
function threadIdSets(emails: Communication[]): string[][] {
  return groupEmailsForIndex(emails).map((t) =>
    t.emails.map((e) => e.id).sort()
  );
}

describe("normalizeEmailSubject", () => {
  it("strips repeated Re:/Fwd:/FW: prefixes (case-insensitive) and lowercases", () => {
    expect(normalizeEmailSubject("Re: Fwd: RE:  Closing Docs")).toBe("closing docs");
    expect(normalizeEmailSubject("FW: Offer")).toBe("offer");
    expect(normalizeEmailSubject("  Inspection  ")).toBe("inspection");
  });

  it("returns empty string for null/undefined/blank", () => {
    expect(normalizeEmailSubject(undefined)).toBe("");
    expect(normalizeEmailSubject(null)).toBe("");
    expect(normalizeEmailSubject("")).toBe("");
  });
});

describe("getEmailIndexThreadKey", () => {
  it("prefers thread_id (raw, unprefixed — same key string as the old export key)", () => {
    expect(getEmailIndexThreadKey(email("1", { thread_id: "T9" }))).toBe("T9");
  });

  it("falls back to normalized subject when no thread_id", () => {
    expect(getEmailIndexThreadKey(email("1", { thread_id: undefined, subject: "Re: Offer" }))).toBe(
      "subject-offer"
    );
  });

  it("last-resorts to per-email id when neither thread_id nor subject", () => {
    expect(
      getEmailIndexThreadKey(email("42", { thread_id: undefined, subject: undefined }))
    ).toBe("email-42");
  });
});

describe("groupEmailsForIndex", () => {
  it("groups by thread_id — exact ID sets, one thread per thread_id", () => {
    const emails = [
      email("a", { thread_id: "T1", sent_at: "2026-01-01T00:00:00.000Z" }),
      email("b", { thread_id: "T1", sent_at: "2026-01-02T00:00:00.000Z" }),
      email("c", { thread_id: "T2", sent_at: "2026-01-03T00:00:00.000Z" }),
    ];
    // Two threads: {a,b} and {c}.
    expect(threadIdSets(emails)).toEqual([["a", "b"], ["c"]]);
    expect(countEmailIndexThreads(emails)).toBe(2);
  });

  it("REGRESSION: no thread_id + shared normalized subject + DIFFERENT participants collapses to ONE thread", () => {
    // These would be SPLIT by the participants-based getThreadKey, but the app
    // (and this helper) group them into ONE conversation by normalized subject.
    const emails = [
      email("m1", {
        thread_id: undefined,
        subject: "Closing Documents",
        sender: "alice@x.com",
        recipients: "bob@y.com",
        sent_at: "2026-02-01T00:00:00.000Z",
      }),
      email("m2", {
        thread_id: undefined,
        subject: "Re: Closing Documents",
        sender: "carol@z.com",
        recipients: "dan@w.com",
        sent_at: "2026-02-02T00:00:00.000Z",
      }),
    ];
    expect(threadIdSets(emails)).toEqual([["m1", "m2"]]);
    expect(countEmailIndexThreads(emails)).toBe(1);
  });

  it("keeps distinct subjects (no thread_id) as separate threads", () => {
    const emails = [
      email("s1", { thread_id: undefined, subject: "Offer", sent_at: "2026-03-01T00:00:00.000Z" }),
      email("s2", { thread_id: undefined, subject: "Inspection", sent_at: "2026-03-02T00:00:00.000Z" }),
    ];
    expect(countEmailIndexThreads(emails)).toBe(2);
    expect(threadIdSets(emails)).toEqual([["s1"], ["s2"]]);
  });

  it("no thread_id and no subject → one thread per email (email-<id> key)", () => {
    const emails = [
      email("n1", { thread_id: undefined, subject: undefined, sent_at: "2026-04-01T00:00:00.000Z" }),
      email("n2", { thread_id: undefined, subject: undefined, sent_at: "2026-04-02T00:00:00.000Z" }),
    ];
    expect(countEmailIndexThreads(emails)).toBe(2);
  });

  it("UNTYPED record (no channel, no communication_type) still groups (never dropped by the grouper)", () => {
    // The export passes an already-email-filtered set; the grouper itself does
    // not re-filter. An untyped record that reaches the grouper is grouped by the
    // same key rules, matching the renderer's untyped-as-email behavior.
    const emails = [
      email("u1", {
        channel: undefined,
        communication_type: undefined,
        thread_id: "T7",
        sent_at: "2026-05-01T00:00:00.000Z",
      }),
      email("u2", {
        channel: undefined,
        communication_type: undefined,
        thread_id: "T7",
        sent_at: "2026-05-02T00:00:00.000Z",
      }),
    ];
    expect(threadIdSets(emails)).toEqual([["u1", "u2"]]);
    expect(countEmailIndexThreads(emails)).toBe(1);
  });

  it("orders threads oldest-first by their first email; sorts within-thread oldest-first", () => {
    const emails = [
      email("late", { thread_id: "L", sent_at: "2026-06-10T00:00:00.000Z" }),
      email("early2", { thread_id: "E", sent_at: "2026-06-02T00:00:00.000Z" }),
      email("early1", { thread_id: "E", sent_at: "2026-06-01T00:00:00.000Z" }),
    ];
    const threads = groupEmailsForIndex(emails);
    // Thread E (first email 06-01) before thread L (06-10). Keys are raw thread_ids.
    expect(threads.map((t) => t.key)).toEqual(["E", "L"]);
    // Within thread E, early1 (06-01) before early2 (06-02).
    expect(threads[0].emails.map((e) => e.id)).toEqual(["early1", "early2"]);
  });

  it("uses the first (oldest) email's subject/sender as the thread representative", () => {
    const emails = [
      email("r2", { thread_id: "R", subject: "Re: Deal", sender: "second@x.com", sent_at: "2026-07-02T00:00:00.000Z" }),
      email("r1", { thread_id: "R", subject: "Deal", sender: "first@x.com", sent_at: "2026-07-01T00:00:00.000Z" }),
    ];
    const [thread] = groupEmailsForIndex(emails);
    expect(thread.subject).toBe("Deal");
    expect(thread.sender).toBe("first@x.com");
  });

  it("returns [] for empty input", () => {
    expect(groupEmailsForIndex([])).toEqual([]);
    expect(countEmailIndexThreads([])).toBe(0);
  });
});
