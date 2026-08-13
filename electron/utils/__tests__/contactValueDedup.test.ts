/**
 * @jest-environment node
 *
 * BACKLOG-2457 — one mailbox listed under two field types must render once.
 *
 * ---------------------------------------------------------------------------
 * ASSERTION STYLE — EXACT VALUE SETS, NEVER COUNTS
 * ---------------------------------------------------------------------------
 * `expect(emails).toHaveLength(1)` is equally satisfied by a helper that throws
 * away the WRONG address, or by one that returns a hardcoded first element. Every
 * assertion below names the exact array it expects, in order.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES ARE FICTIONAL (BACKLOG-2485) — DO NOT "IMPROVE" THEM WITH REAL DATA
 * ---------------------------------------------------------------------------
 * This bug was reported against a real person in the founder's address book, so
 * the tempting fixture is that record verbatim. This repository is PUBLIC: a
 * contact's name, mailbox and mobile number are that third party's personal
 * data. Every value below is from a range reserved so it cannot collide with
 * anyone real — `example.test` / `example.com` (RFC 2606) and `555-01xx`
 * numbers — with invented names. The defect reproduces identically.
 */

import { dedupeEmailValues, dedupePhoneValues } from "../contactValueDedup";

describe("dedupeEmailValues", () => {
  it("collapses the reported card: one address, two Outlook field types", () => {
    // The reported shape: `Email` and the chat field carrying one mailbox.
    // Microsoft Graph returns both in one `emailAddresses` array.
    expect(
      dedupeEmailValues(["quillfeather@example.test", "quillfeather@example.test"]),
    ).toEqual(["quillfeather@example.test"]);
  });

  it("keeps two genuinely different addresses — both of them, in order", () => {
    expect(
      dedupeEmailValues(["work@example.test", "robin@example.com"]),
    ).toEqual(["work@example.test", "robin@example.com"]);
  });

  it("treats case and trailing whitespace as the same mailbox", () => {
    expect(
      dedupeEmailValues(["Robin@Example.test", "robin@example.test ", "  ROBIN@EXAMPLE.TEST"]),
    ).toEqual(["Robin@Example.test"]);
  });

  it("keeps the FIRST spelling — the card shows what the address book says", () => {
    // Not lowercased on the way out. A silently rewritten address is a second,
    // quieter version of "the picker is showing something I did not type".
    expect(dedupeEmailValues(["  Robin@Example.test  ", "robin@example.test"])).toEqual([
      "Robin@Example.test",
    ]);
  });

  it("collapses a duplicate without disturbing the neighbours' order", () => {
    expect(
      dedupeEmailValues([
        "a@example.test",
        "dup@example.test",
        "b@example.test",
        "DUP@example.test",
        "c@example.test",
      ]),
    ).toEqual(["a@example.test", "dup@example.test", "b@example.test", "c@example.test"]);
  });

  it("drops blanks and non-strings rather than rendering an empty row", () => {
    // emails_json is a TEXT column written by several providers over several
    // schema versions; a null or a number in there must not become a card row.
    expect(
      dedupeEmailValues([
        "",
        "   ",
        null,
        undefined,
        42,
        { address: "x@example.test" },
        "real@example.test",
      ]),
    ).toEqual(["real@example.test"]);
  });

  it("returns [] for a non-array (a corrupt JSON object, say) and for null", () => {
    expect(dedupeEmailValues(null)).toEqual([]);
    expect(dedupeEmailValues(undefined)).toEqual([]);
    expect(dedupeEmailValues({} as unknown as unknown[])).toEqual([]);
    expect(dedupeEmailValues([])).toEqual([]);
  });

  it("does not collapse addresses that merely share a local part or domain", () => {
    expect(
      dedupeEmailValues(["robin@example.test", "robin@example.com", "robins@example.test"]),
    ).toEqual(["robin@example.test", "robin@example.com", "robins@example.test"]);
  });
});

describe("dedupePhoneValues", () => {
  it("collapses one number carried under two labels (mobile + iPhone)", () => {
    // Apple's unified cards routinely do this; Graph flattens mobilePhone +
    // homePhones + businessPhones into one array and produces it too.
    expect(dedupePhoneValues(["(555) 555-0142", "+1 555-555-0142"])).toEqual([
      "(555) 555-0142",
    ]);
  });

  it("collapses across every spelling of the same number", () => {
    expect(
      dedupePhoneValues([
        "5555550142",
        "555.555.0142",
        "+1 (555) 555-0142",
        " 555 555 0142 ",
      ]),
    ).toEqual(["5555550142"]);
  });

  it("keeps two genuinely different numbers — both of them, in order", () => {
    expect(dedupePhoneValues(["5555550142", "(555) 555-0187"])).toEqual([
      "5555550142",
      "(555) 555-0187",
    ]);
  });

  it("keeps the FIRST spelling, punctuation and all", () => {
    expect(dedupePhoneValues(["+1 (555) 555-0142", "5555550142"])).toEqual([
      "+1 (555) 555-0142",
    ]);
  });

  it("does not fold two different non-numeric entries into one", () => {
    // toLookupKey returns the trimmed input when there are no digits at all.
    // Dedup must never be a licence to hide a value it failed to parse.
    expect(dedupePhoneValues(["ext. main", "ext. spare"])).toEqual([
      "ext. main",
      "ext. spare",
    ]);
  });

  it("drops blanks and non-strings", () => {
    expect(
      dedupePhoneValues(["", "  ", null, undefined, 5555550142, "5555550187"]),
    ).toEqual(["5555550187"]);
  });

  it("returns [] for a non-array and for null", () => {
    expect(dedupePhoneValues(null)).toEqual([]);
    expect(dedupePhoneValues(undefined)).toEqual([]);
    expect(dedupePhoneValues({} as unknown as unknown[])).toEqual([]);
  });

  it("keeps short numbers distinct from each other", () => {
    // Under 10 digits, toLookupKey keys on the digits it has — "8675" and "3099"
    // must stay two values.
    expect(dedupePhoneValues(["8675", "3099", "86-75"])).toEqual(["8675", "3099"]);
  });
});
