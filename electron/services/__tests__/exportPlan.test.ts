/**
 * BACKLOG-2771 — the export plan resolver.
 *
 * This is the ONE place the include set is decided. Before it there were three
 * implementations (the folder handler's inline pair, enhancedExportService's
 * private pair, and `transactions:export-pdf`'s absence of one), the
 * BACKLOG-2343 timezone fix had to be written twice, and the two copies still
 * disagreed afterwards.
 *
 * The date cases below are ported verbatim from `enhancedExportService.test.ts`,
 * which exercised the copy that has now been deleted. They assert the same
 * behavior against the surviving implementation, so the BACKLOG-2343 regression
 * stays guarded rather than being retired with its old host.
 *
 * `exportIncludeSet-2771.test.ts` asserts that every IPC entry point actually
 * routes through this resolver — mutating the boundary here reds both suites.
 */

import type { Communication } from "../../types/models";
import { resolveExportPlan, orderAttachmentComms, normalizeContentType } from "../exportPlan";

const email = (id: string, sentAt: string | null, extra: Partial<Communication> = {}): Communication =>
  ({
    id,
    sent_at: sentAt,
    subject: `Email ${id}`,
    sender: "test@example.com",
    recipients: "recipient@example.com",
    communication_type: "email",
    channel: "email",
    ...extra,
  }) as unknown as Communication;

const text = (id: string, sentAt: string | null, extra: Partial<Communication> = {}): Communication =>
  ({
    id,
    sent_at: sentAt,
    communication_type: "sms",
    channel: "sms",
    ...extra,
  }) as unknown as Communication;

/** A folder-export request with no audit window and everything selected. */
const plan = (
  communications: Communication[],
  overrides: Partial<Parameters<typeof resolveExportPlan>[0]> = {},
) =>
  resolveExportPlan(
    {
      format: "folder",
      contentType: "both",
      attachmentType: "all",
      emailMode: "thread",
      ...overrides,
    },
    communications,
  );

const ids = (comms: Communication[]): string[] => comms.map((c) => c.id as string);

describe("resolveExportPlan — audit window (BACKLOG-2343)", () => {
  // All at 10:00Z on their day.
  const sample: Communication[] = [
    email("1", "2024-01-01T10:00:00Z"), // Before range
    email("2", "2024-01-15T10:00:00Z"), // Start of range
    email("3", "2024-02-01T10:00:00Z"), // In range
    email("4", "2024-02-15T10:00:00Z"), // In range
    email("5", "2024-03-01T10:00:00Z"), // End of range
    email("6", "2024-03-15T10:00:00Z"), // After range
  ];

  const window = (startDate?: string, endDate?: string): string[] =>
    ids(plan(sample, { startDate, endDate }).communications);

  it("returns all communications when no dates are provided", () => {
    expect(window(undefined, undefined)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("filters communications before the start date", () => {
    expect(window("2024-01-15", undefined)).toEqual(["2", "3", "4", "5", "6"]);
  });

  it("INCLUDES messages sent on the end date (inclusive closing day)", () => {
    // End date "2024-03-01" covers ALL of March 1st, so #5 is kept. Callers pass
    // the transaction's closed_at directly; no caller passes "the day after".
    expect(window(undefined, "2024-03-01")).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("filters communications outside the range (both dates)", () => {
    expect(window("2024-01-15", "2024-03-01")).toEqual(["2", "3", "4", "5"]);
  });

  it("includes a message on the end date at a later time of day", () => {
    // BACKLOG-2343 core regression: "2024-03-15" (midnight UTC) previously
    // EXCLUDED the 2024-03-15T10:00Z message.
    expect(window("2024-01-01", "2024-03-15")).toContain("6");
  });

  it("still excludes messages sent after the end date", () => {
    expect(window("2024-01-01", "2024-03-14")).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("keeps a text sent late on the closing day in a UTC-negative timezone", () => {
    // Founder repro: text sent Jul 28 ~11:30pm America/Chicago (UTC-5) is stored
    // as 2026-07-29T04:30Z. Audit window Jan 1 - Jul 29 2026. Before the fix it
    // was dropped and the Audit Summary showed "TOTAL TEXT MESSAGES: 0".
    const inWindow = text("t", "2026-07-29T04:30:00Z");
    const result = plan([inWindow], { startDate: "2026-01-01", endDate: "2026-07-29" });
    expect(ids(result.communications)).toEqual(["t"]);
  });

  it("handles an empty communications array", () => {
    expect(ids(plan([], { startDate: "2024-01-15", endDate: "2024-03-01" }).communications)).toEqual([]);
  });

  it("handles a start date after every communication", () => {
    expect(window("2024-12-01", undefined)).toEqual([]);
  });

  it("handles an end date before every communication", () => {
    expect(window(undefined, "2023-01-01")).toEqual([]);
  });

  it("handles ISO date strings with a time component", () => {
    expect(window("2024-01-15T00:00:00Z", "2024-03-01T23:59:59Z")).toEqual(["2", "3", "4", "5"]);
  });
});

describe("resolveExportPlan — the sent_at fallback (BACKLOG-2771: `||`, not `??`)", () => {
  /*
   * The two deleted copies disagreed here: the folder handler used
   * `comm.sent_at || comm.received_at`, enhancedExportService used
   * `comm.sent_at ?? comm.received_at` while its own comment claimed "parity
   * with the folder-export handler".
   *
   * The divergence is LATENT, not live. Evidence from the producers:
   *   - `getCommunicationsWithMessages` projects `COALESCE(m.sent_at, e.sent_at)
   *     as sent_at` — a datetime string or SQL NULL.
   *   - `emailDbService.createEmail` binds `emailData.sent_at || null`, so an
   *     empty string is stored as NULL, never as "".
   *   - The macOS Messages importer binds `sentAt.toISOString()`, which is
   *     never empty.
   * `||` and `??` are IDENTICAL on null and undefined, so no shipped row can
   * tell them apart today. `||` is pinned because it is the safer of the two if
   * a future producer ever does emit "" — see the defensive case below.
   */

  it("falls back to received_at when sent_at is NULL (the value the projection emits)", () => {
    const row = text("r", null, { received_at: "2024-02-10T10:00:00Z" });
    const result = plan([row], { startDate: "2024-01-01", endDate: "2024-03-01" });
    expect(ids(result.communications)).toEqual(["r"]);
  });

  it("drops a NULL-sent_at row whose received_at is outside the window", () => {
    // Anti-vacuity for the case above: the fallback is really being read, not
    // just producing an Invalid Date that passes every comparison.
    const row = text("r", null, { received_at: "2024-06-01T10:00:00Z" });
    const result = plan([row], { startDate: "2024-01-01", endDate: "2024-03-01" });
    expect(ids(result.communications)).toEqual([]);
  });

  it("falls back to received_at when sent_at is undefined", () => {
    const row = text("r", undefined as unknown as null, { received_at: "2024-02-10T10:00:00Z" });
    const result = plan([row], { startDate: "2024-01-01", endDate: "2024-03-01" });
    expect(ids(result.communications)).toEqual(["r"]);
  });

  it('DEFENSIVE: an empty-string sent_at falls back rather than admitting an out-of-window row', () => {
    // No producer emits "" today (see the writer coercions above), so this is a
    // semantics pin, not a live regression guard. Under `??` the empty string
    // survives, `new Date("")` is an Invalid Date, BOTH boundary comparisons are
    // false, and this out-of-window row is silently EXPORTED. Under `||` the
    // received_at fallback is read and the row is correctly excluded.
    const outOfWindow = text("r", "" as unknown as null, { received_at: "2024-06-01T10:00:00Z" });
    const result = plan([outOfWindow], { startDate: "2024-01-01", endDate: "2024-03-01" });
    expect(ids(result.communications)).toEqual([]);
  });
});

describe("resolveExportPlan — content selection", () => {
  const mixed = [email("e1", "2024-02-01T10:00:00Z"), text("t1", "2024-02-02T10:00:00Z")];

  it('"both" includes emails and texts', () => {
    const p = plan(mixed);
    expect(ids(p.communications)).toEqual(["e1", "t1"]);
    expect(p.includeEmails).toBe(true);
    expect(p.includeTexts).toBe(true);
  });

  it('"emails" includes only emails', () => {
    const p = plan(mixed, { contentType: "emails" });
    expect(ids(p.communications)).toEqual(["e1"]);
    expect(p.includeEmails).toBe(true);
    expect(p.includeTexts).toBe(false);
  });

  it('"texts" includes only texts', () => {
    const p = plan(mixed, { contentType: "texts" });
    expect(ids(p.communications)).toEqual(["t1"]);
    expect(p.includeEmails).toBe(false);
    expect(p.includeTexts).toBe(true);
  });

  it("applies the audit window BEFORE the content filter, as both deleted copies did", () => {
    const p = plan(mixed, { contentType: "both", startDate: "2024-02-02", endDate: "2024-02-02" });
    expect(ids(p.communications)).toEqual(["t1"]);
  });
});

describe("resolveExportPlan — attachment selection", () => {
  const mixed = [email("e1", "2024-02-01T10:00:00Z"), text("t1", "2024-02-02T10:00:00Z")];

  // CONTROL 1 (BACKLOG-2771): "none" writes nothing, for every format.
  it.each(["folder", "pdf", "csv", "excel", "json", "txt_eml"] as const)(
    '%s + attachmentType "none" selects zero attachment communications',
    (format) => {
      const p = plan(mixed, { format, attachmentType: "none" });
      expect(p.writesAttachmentsToDisk).toBe(false);
      expect(p.attachmentComms).toEqual([]);
    },
  );

  it.each(["csv", "excel", "json", "txt_eml"] as const)(
    "%s never writes attachment files even when the user selected them",
    (format) => {
      const p = plan(mixed, { format, attachmentType: "all" });
      expect(p.writesAttachmentsToDisk).toBe(false);
      expect(p.attachmentComms).toEqual([]);
    },
  );

  it.each(["folder", "pdf"] as const)("%s + \"all\" selects both emails and texts", (format) => {
    const p = plan(mixed, { format, attachmentType: "all" });
    expect(p.writesAttachmentsToDisk).toBe(true);
    expect(ids(p.attachmentComms)).toEqual(["e1", "t1"]);
  });

  it('"email" selects only emails; "text" selects only texts', () => {
    expect(ids(plan(mixed, { attachmentType: "email" }).attachmentComms)).toEqual(["e1"]);
    expect(ids(plan(mixed, { attachmentType: "text" }).attachmentComms)).toEqual(["t1"]);
  });

  it("a summary-only PDF writes no attachments even with everything selected", () => {
    const p = plan(mixed, { format: "pdf", attachmentType: "all", summaryOnly: true });
    expect(p.writesAttachmentsToDisk).toBe(false);
    expect(p.attachmentComms).toEqual([]);
  });

  it("the attachment selection is a SUBSET of what the export includes", () => {
    // Texts are excluded from the export, so their attachments cannot be
    // written no matter what the attachment selector says.
    const p = plan(mixed, { contentType: "emails", attachmentType: "all" });
    expect(ids(p.attachmentComms)).toEqual(["e1"]);
  });

  it("the audit window narrows the attachment selection too", () => {
    const p = plan(mixed, { attachmentType: "all", startDate: "2024-02-02", endDate: "2024-02-02" });
    expect(ids(p.attachmentComms)).toEqual(["t1"]);
  });
});

describe("orderAttachmentComms — the plan decides membership, the renderer decides order", () => {
  const e1 = email("e1", "2024-02-01T10:00:00Z");
  const t1 = text("t1", "2024-02-02T10:00:00Z");

  it("re-orders the selection without changing it", () => {
    const p = plan([e1, t1], { attachmentType: "all" });
    expect(ids(orderAttachmentComms(p, [t1, e1]))).toEqual(["t1", "e1"]);
  });

  it("drops anything the plan did not select, whatever order it is offered in", () => {
    const p = plan([e1, t1], { attachmentType: "email" });
    expect(ids(orderAttachmentComms(p, [t1, e1]))).toEqual(["e1"]);
  });

  it("returns nothing when the plan writes no attachments", () => {
    const p = plan([e1, t1], { attachmentType: "none" });
    expect(orderAttachmentComms(p, [e1, t1])).toEqual([]);
  });
});

describe("normalizeContentType — one vocabulary at the boundary", () => {
  it("accepts the canonical spelling", () => {
    expect(normalizeContentType("both")).toBe("both");
    expect(normalizeContentType("emails")).toBe("emails");
    expect(normalizeContentType("texts")).toBe("texts");
  });

  it("maps the retired enhanced-export spelling rather than silently widening", () => {
    // A renderer running from a previous build still sends "email"/"text".
    // Falling through to "both" would export MORE than the user asked for.
    expect(normalizeContentType("email")).toBe("emails");
    expect(normalizeContentType("text")).toBe("texts");
  });

  it("falls back to \"both\" for missing or unrecognized values", () => {
    expect(normalizeContentType(undefined)).toBe("both");
    expect(normalizeContentType("nonsense")).toBe("both");
  });
});
