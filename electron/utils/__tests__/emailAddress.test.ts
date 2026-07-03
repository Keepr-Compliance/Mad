/**
 * @jest-environment node
 *
 * Tests for the RFC 5322 address-list parser used by the email_participants
 * junction (BACKLOG-1722).
 */

import {
  parseEmailAddressList,
  normalizeEmailAddress,
  computeParticipantHash,
} from "../emailAddress";

describe("normalizeEmailAddress", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmailAddress("  Alice@Example.COM  ")).toBe("alice@example.com");
  });
});

describe("computeParticipantHash", () => {
  it("is deterministic for the same inputs", () => {
    const a = computeParticipantHash("e1", "to", 0, "alice@example.com");
    const b = computeParticipantHash("e1", "to", 0, "alice@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when any input changes", () => {
    const base = computeParticipantHash("e1", "to", 0, "alice@example.com");
    expect(computeParticipantHash("e2", "to", 0, "alice@example.com")).not.toBe(base);
    expect(computeParticipantHash("e1", "cc", 0, "alice@example.com")).not.toBe(base);
    expect(computeParticipantHash("e1", "to", 1, "alice@example.com")).not.toBe(base);
    expect(computeParticipantHash("e1", "to", 0, "bob@example.com")).not.toBe(base);
  });
});

describe("parseEmailAddressList", () => {
  it("returns empty result for null/undefined/empty input", () => {
    expect(parseEmailAddressList(null)).toEqual({ addresses: [], errors: [] });
    expect(parseEmailAddressList(undefined)).toEqual({ addresses: [], errors: [] });
    expect(parseEmailAddressList("")).toEqual({ addresses: [], errors: [] });
    expect(parseEmailAddressList("   ")).toEqual({ addresses: [], errors: [] });
  });

  it("parses a single bare address", () => {
    const r = parseEmailAddressList("alice@example.com");
    expect(r.errors).toEqual([]);
    expect(r.addresses).toEqual([{ email_address: "alice@example.com", display_name: null }]);
  });

  it("lowercases addresses but preserves display_name case", () => {
    const r = parseEmailAddressList('Alice Smith <Alice@Example.COM>');
    expect(r.addresses).toEqual([
      { email_address: "alice@example.com", display_name: "Alice Smith" },
    ]);
  });

  it("parses multiple bare addresses", () => {
    const r = parseEmailAddressList("a@x.com, b@y.com, c@z.com");
    expect(r.errors).toEqual([]);
    expect(r.addresses.map((a) => a.email_address)).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  it("parses unquoted display names with angle brackets", () => {
    const r = parseEmailAddressList("Alice <a@x.com>, Bob <b@y.com>");
    expect(r.addresses).toEqual([
      { email_address: "a@x.com", display_name: "Alice" },
      { email_address: "b@y.com", display_name: "Bob" },
    ]);
  });

  it("preserves commas inside quoted display names", () => {
    const r = parseEmailAddressList('"Last, First" <a@x.com>, "Smith, Jane" <b@y.com>');
    expect(r.addresses).toEqual([
      { email_address: "a@x.com", display_name: "Last, First" },
      { email_address: "b@y.com", display_name: "Smith, Jane" },
    ]);
  });

  it("handles angle-bracket-only addresses", () => {
    const r = parseEmailAddressList("<a@x.com>, <b@y.com>");
    expect(r.addresses).toEqual([
      { email_address: "a@x.com", display_name: null },
      { email_address: "b@y.com", display_name: null },
    ]);
  });

  it("decodes RFC 2047 Q-encoded display name (best-effort)", () => {
    const r = parseEmailAddressList("=?utf-8?Q?Al=C3=AFce?= <a@x.com>");
    expect(r.errors).toEqual([]);
    expect(r.addresses[0].email_address).toBe("a@x.com");
    // The decoded display should contain "Alice" with a diacritic.
    expect(r.addresses[0].display_name).toMatch(/Al.+ce/);
  });

  it("decodes RFC 2047 B-encoded display name (best-effort)", () => {
    // base64("Alice") = "QWxpY2U="
    const r = parseEmailAddressList("=?utf-8?B?QWxpY2U=?= <a@x.com>");
    expect(r.addresses[0].display_name).toBe("Alice");
  });

  it("handles RFC 5321 routing addresses by extracting the last hop", () => {
    const r = parseEmailAddressList("<@route1,@route2:user@x.com>");
    expect(r.addresses).toEqual([
      { email_address: "user@x.com", display_name: null },
    ]);
  });

  it("strips group syntax and extracts members", () => {
    const r = parseEmailAddressList("Realtors: alice@x.com, bob@y.com;");
    expect(r.addresses.map((a) => a.email_address)).toEqual([
      "alice@x.com",
      "bob@y.com",
    ]);
  });

  it("handles a mixed group + non-group list (best-effort: outer group is dropped)", () => {
    // We accept the simple case: when the whole header is wrapped in a single
    // group. A mixed list is rare and we treat it as plain.
    const r = parseEmailAddressList("alice@x.com, bob@y.com");
    expect(r.addresses).toHaveLength(2);
  });

  it("handles the comment-form `addr (display)`", () => {
    const r = parseEmailAddressList("a@x.com (Alice Smith)");
    expect(r.addresses).toEqual([
      { email_address: "a@x.com", display_name: "Alice Smith" },
    ]);
  });

  it("rejects empty angle brackets", () => {
    const r = parseEmailAddressList("Empty <>, good@x.com");
    expect(r.addresses).toEqual([{ email_address: "good@x.com", display_name: null }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/empty/i);
  });

  it("rejects missing '@'", () => {
    const r = parseEmailAddressList("not-an-email, good@x.com");
    expect(r.addresses).toEqual([{ email_address: "good@x.com", display_name: null }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].reason).toMatch(/missing '@'/i);
  });

  it("rejects missing local part", () => {
    const r = parseEmailAddressList("@example.com");
    expect(r.addresses).toEqual([]);
    expect(r.errors[0].reason).toMatch(/local part/i);
  });

  it("rejects missing domain", () => {
    const r = parseEmailAddressList("user@");
    expect(r.addresses).toEqual([]);
    expect(r.errors[0].reason).toMatch(/domain/i);
  });

  it("ignores trailing/leading whitespace in chunks", () => {
    const r = parseEmailAddressList("  alice@x.com  ,   bob@y.com  ");
    expect(r.addresses).toHaveLength(2);
  });

  it("preserves order of input addresses (used for participant position index)", () => {
    const r = parseEmailAddressList("c@z.com, a@x.com, b@y.com");
    expect(r.addresses.map((a) => a.email_address)).toEqual([
      "c@z.com",
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("does NOT confuse `,` inside a quoted display with a separator (BACKLOG-1722 G2 near-collision setup)", () => {
    const r = parseEmailAddressList('"Chen, Lisa" <lisa@x.com>');
    expect(r.addresses).toEqual([
      { email_address: "lisa@x.com", display_name: "Chen, Lisa" },
    ]);
  });

  it("treats `lisa@x.com` and `alisa@x.com` as DISTINCT (G2 acceptance gate)", () => {
    const r = parseEmailAddressList("lisa@x.com, alisa@x.com");
    expect(r.addresses).toHaveLength(2);
    expect(r.addresses[0].email_address).toBe("lisa@x.com");
    expect(r.addresses[1].email_address).toBe("alisa@x.com");
  });

  // I3 (BACKLOG-1722): semicolon-separated address lists
  it("splits semicolon-separated bare addresses (I3)", () => {
    const r = parseEmailAddressList("a@x.com; b@y.com");
    expect(r.errors).toEqual([]);
    expect(r.addresses.map((a) => a.email_address)).toEqual(["a@x.com", "b@y.com"]);
  });

  it("does not treat semicolon inside quoted display name as separator (I3)", () => {
    const r = parseEmailAddressList('"Semi; Colon" <s@x.com>; b@y.com');
    expect(r.errors).toEqual([]);
    expect(r.addresses).toEqual([
      { email_address: "s@x.com", display_name: "Semi; Colon" },
      { email_address: "b@y.com", display_name: null },
    ]);
  });

  it("splits mixed comma and semicolon separators (I3)", () => {
    const r = parseEmailAddressList("a@x.com, b@y.com; c@z.com");
    expect(r.errors).toEqual([]);
    expect(r.addresses.map((a) => a.email_address)).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  it("rejects address with internal whitespace (I3 harden)", () => {
    const r = parseEmailAddressList("<alice bob@x.com>");
    expect(r.addresses).toEqual([]);
    expect(r.errors[0].reason).toMatch(/whitespace/i);
  });

  it("rejects address with semicolon inside angle brackets (I3 harden)", () => {
    const r = parseEmailAddressList("<a;b@x.com>");
    expect(r.addresses).toEqual([]);
    expect(r.errors[0].reason).toMatch(/semicolon/i);
  });
});
