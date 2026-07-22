/**
 * @jest-environment node
 *
 * Tests for generateSummaryHTML's Email Threads Index header + row labels
 * (BACKLOG-2161 founder QA refinement, 2026-07-20).
 *
 * Founder QA evidence: a real export with 5 emails / 3 conversations rendered
 * "Email Threads Index (3)" — read as an ambiguous EMAIL count. Two fixes:
 *   1. Thread View header must mirror the app's on-screen phrasing exactly:
 *      "{N} conversation{s} ({M} email{s})" (TransactionEmailsTab.tsx).
 *      Individual mode keeps its existing bare per-email count.
 *   2. Each Thread View row carries data-multi="true|false" so the combined-PDF
 *      link injector can label multi-email threads "View Thread →" and
 *      single-email groups "View →" (see combinedExportHelpers.test.ts).
 *
 * These are presentation-only assertions — grouping/count correctness is
 * covered by emailIndexHelpers.test.ts and is NOT re-verified here.
 */

import { generateSummaryHTML } from "../summaryHelpers";
import type { Communication } from "../../../types/models";
import type { TransactionWithDetails } from "../../transactionService/types";

function email(id: string, fields: Partial<Communication> = {}): Communication {
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

function transaction(fields: Partial<TransactionWithDetails> = {}): TransactionWithDetails {
  return {
    id: "txn-1",
    user_id: "user-123",
    property_address: "123 Main St",
    status: "active",
    message_count: 0,
    attachment_count: 0,
    export_status: "not_exported",
    export_count: 0,
    ...fields,
  } as TransactionWithDetails;
}

describe("generateSummaryHTML — Email Threads Index header (BACKLOG-2161 QA refinement)", () => {
  it("thread mode: header mirrors the app's on-screen phrasing — N conversations - M emails, plural", () => {
    // 3 conversations from founder's real evidence: one 3-email thread + two singles = 5 emails.
    const emails = [
      email("t1a", { thread_id: "T1", subject: "Owner of App", sent_at: "2026-01-01T00:00:00.000Z" }),
      email("t1b", { thread_id: "T1", subject: "Re: Owner of App", sent_at: "2026-01-02T00:00:00.000Z" }),
      email("t1c", { thread_id: "T1", subject: "Re: Owner of App", sent_at: "2026-01-03T00:00:00.000Z" }),
      email("q1", { thread_id: undefined, subject: "Qantas", sent_at: "2026-01-04T00:00:00.000Z" }),
      email("m1", { thread_id: undefined, subject: "Monarch", sent_at: "2026-01-05T00:00:00.000Z" }),
    ];
    const html = generateSummaryHTML(transaction(), emails, undefined, "thread");
    // BACKLOG-1842 (visual-polish, founder QA): inner parens around the email
    // count replaced with " - " to avoid the awkward "(N (M))" double-nesting.
    expect(html).toContain("<h3>Email Threads Index (3 conversations - 5 emails)</h3>");
    // Must NOT regress to the ambiguous bare-count header, nor the old nested-parens form.
    expect(html).not.toContain("<h3>Email Threads Index (3)</h3>");
    expect(html).not.toContain("<h3>Email Threads Index (3 conversations (5 emails))</h3>");
  });

  it("thread mode: singular conversation and singular email are both grammatically correct", () => {
    const emails = [email("only", { thread_id: "T1" })];
    const html = generateSummaryHTML(transaction(), emails, undefined, "thread");
    expect(html).toContain("<h3>Email Threads Index (1 conversation - 1 email)</h3>");
  });

  it("thread mode: singular conversation with multiple emails in that one thread", () => {
    const emails = [
      email("a", { thread_id: "T1", sent_at: "2026-01-01T00:00:00.000Z" }),
      email("b", { thread_id: "T1", sent_at: "2026-01-02T00:00:00.000Z" }),
    ];
    const html = generateSummaryHTML(transaction(), emails, undefined, "thread");
    expect(html).toContain("<h3>Email Threads Index (1 conversation - 2 emails)</h3>");
  });

  it("individual mode: header stays a bare per-email count (unchanged)", () => {
    const emails = [
      email("a", { thread_id: "T1", sent_at: "2026-01-01T00:00:00.000Z" }),
      email("b", { thread_id: "T1", sent_at: "2026-01-02T00:00:00.000Z" }),
    ];
    const html = generateSummaryHTML(transaction(), emails, undefined, "individual");
    expect(html).toContain("<h3>Email Threads Index (2)</h3>");
    expect(html).not.toContain("conversation");
  });
});

describe("generateSummaryHTML — Thread View row data-multi marker (BACKLOG-2161 QA refinement)", () => {
  it("marks a multi-email thread row data-multi=\"true\" with its (N emails) count label", () => {
    const emails = [
      email("a", { thread_id: "T1", subject: "Owner of App", sent_at: "2026-01-01T00:00:00.000Z" }),
      email("b", { thread_id: "T1", subject: "Re: Owner of App", sent_at: "2026-01-02T00:00:00.000Z" }),
      email("c", { thread_id: "T1", subject: "Re: Owner of App", sent_at: "2026-01-03T00:00:00.000Z" }),
    ];
    const html = generateSummaryHTML(transaction(), emails, undefined, "thread");
    expect(html).toContain('<div class="email-item" data-multi="true">');
    expect(html).toContain("Owner of App (3 emails)");
  });

  it("marks a single-email group row data-multi=\"false\" with no count label", () => {
    const emails = [email("q1", { thread_id: undefined, subject: "Qantas" })];
    const html = generateSummaryHTML(transaction(), emails, undefined, "thread");
    expect(html).toContain('<div class="email-item" data-multi="false">');
    expect(html).not.toContain("Qantas (1 email");
  });

  it("individual mode rows carry no data-multi attribute (unchanged legacy markup)", () => {
    const emails = [email("a", { thread_id: "T1" }), email("b", { thread_id: "T1" })];
    const html = generateSummaryHTML(transaction(), emails, undefined, "individual");
    expect(html).not.toContain("data-multi");
  });
});

/**
 * BACKLOG-2190 (founder QA of the v2.25.0 combined-PDF export):
 *
 * BUG A — the summary's "Closing Date" card read `transaction.closed_at`, which
 *   is the audit-period END (always set), so a deal with NO closing date still
 *   printed one. The real closing field is `transaction.closing_deadline`, and
 *   the on-screen details view (TransactionDetailsTab.tsx) only renders the
 *   "Closing:" line when it is truthy. The card must now read `closing_deadline`
 *   and be OMITTED entirely when it is empty/null — never falling back to
 *   `closed_at`.
 *
 * BUG B — the "Generated on" line used the UTC `formatDate`, so at 20:24 PDT
 *   (04:24 UTC the next day) it printed tomorrow's date. It is a real instant
 *   and must render in the user's LOCAL time via `formatLocalDate`.
 */
describe("generateSummaryHTML — Closing Date card (BACKLOG-2190 BUG A)", () => {
  // Isolate the Closing Date detail-card so assertions don't collide with the
  // Audit Period line, which ALSO renders closed_at ("June 6, 2026").
  function closingCard(html: string): string | null {
    const label = "<div class=\"label\">Closing Date</div>";
    const idx = html.indexOf(label);
    if (idx === -1) return null;
    // The value div immediately follows the label within the same card.
    return html.slice(idx, idx + 160);
  }

  it("uses closing_deadline (NOT closed_at) for the Closing Date value", () => {
    const html = generateSummaryHTML(
      transaction({
        closing_deadline: "2026-03-15T00:00:00.000Z",
        closed_at: "2026-06-06T00:00:00.000Z",
      }),
      [],
      undefined,
      "thread"
    );
    // Closing Date card is present and shows the closing_deadline day...
    const card = closingCard(html);
    expect(card).not.toBeNull();
    expect(card).toContain("March 15, 2026");
    // ...and never leaks the audit-period end (closed_at) into the card. (Note
    // "June 6, 2026" legitimately appears in the Audit Period line, so we scope
    // this negative assertion to the Closing Date card only.)
    expect(card).not.toContain("June 6, 2026");
  });

  it("omits the Closing Date card entirely when closing_deadline is missing", () => {
    const html = generateSummaryHTML(
      // No closing_deadline; closed_at IS set (audit-period end).
      transaction({ closed_at: "2026-06-06T00:00:00.000Z" }),
      [],
      undefined,
      "thread"
    );
    // The Closing Date card must be dropped, not printed with a fallback value.
    expect(html).not.toContain("<div class=\"label\">Closing Date</div>");
    // No Closing Date card exists to leak closed_at into.
    expect(closingCard(html)).toBeNull();
  });

  it("omits the Closing Date card when closing_deadline is an empty string", () => {
    const html = generateSummaryHTML(
      transaction({ closing_deadline: "", closed_at: "2026-06-06T00:00:00.000Z" }),
      [],
      undefined,
      "thread"
    );
    expect(html).not.toContain("<div class=\"label\">Closing Date</div>");
  });
});

describe("generateSummaryHTML — Generated on uses local time (BACKLOG-2190 BUG B)", () => {
  it("renders the Generated on line as today's LOCAL calendar day", () => {
    // The generated-on timestamp is `new Date()` (now). It must render in the
    // user's LOCAL time, not UTC. We compare against the local-formatted "now"
    // the same way the fixed code does; the divergence from the UTC formatter
    // is exhaustively covered in exportUtils.test.ts (formatLocalDate).
    const expectedLocalToday = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const html = generateSummaryHTML(transaction(), [], undefined, "thread");
    expect(html).toContain(`Generated on ${expectedLocalToday}`);
  });
});
