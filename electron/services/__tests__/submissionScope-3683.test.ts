/**
 * @jest-environment node
 *
 * BACKLOG-3683 (founder decision B, narrowed 2026-10-05) — the scope preview
 * counts exactly what a submission with the same dates sends. There is no
 * out-of-window notice: the founder removed it ("i don't think we need this
 * msg just remove it").
 *
 * The database is a fake whose windowed reads apply the predicate transcribed
 * from submissionDbService.ts (getTransactionMessages :46-54, getTransactionEmails
 * :79-87): `sent_at >= start.toISOString()` and
 * `sent_at <= auditWindowEnd(end).toISOString()`, compared as strings.
 *
 * C2 — gather and preview read the dates through ONE function
 *      (`auditPeriodFromRow`). The module is wrapped so a test can make it
 *      return sentinel Dates; a preview with its own copy never passes them on.
 */

jest.mock("../databaseService");
jest.mock("../logService");
jest.mock("../supabaseService");
jest.mock("../supabaseStorageService");
jest.mock("../emailAttachmentService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../contactResolutionService", () => ({
  resolveHandles: jest.fn().mockResolvedValue({ names: { "+15550100": "Jane Fixture" }, matches: {} }),
  extractParticipantHandles: jest.fn(() => []),
  nameForHandle: jest.fn((res: { names: Record<string, string> }, h: string) => res.names[h]),
}));
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.39.0"), getPath: jest.fn(() => "/nonexistent") },
  net: { isOnline: () => false },
}));
jest.mock("../submissionAuditPeriod", () => {
  const actual = jest.requireActual("../submissionAuditPeriod");
  return { ...actual, auditPeriodFromRow: jest.fn(actual.auditPeriodFromRow) };
});

import { submissionService } from "../submissionService";
import supabaseService from "../supabaseService";
import databaseService from "../databaseService";
import { auditWindowEnd } from "../exportPlan";
import { auditPeriodFromRow } from "../submissionAuditPeriod";
import { setPreflightStatForTests } from "../submissionPreflight";
import { installErrorReporter, resetErrorReporter } from "../../capabilities/errorReporterProvider";
import type { ErrorReporter } from "../../capabilities/errorReporter";

type Row = Record<string, unknown>;
const TX = "txn-3683";
const USER = "user-3683";

/** Local wall-clock instant, as the agent's machine stores it. */
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0).toISOString();

const TEXTS: Row[] = [
  { id: "t-before", sent_at: local(2026, 8, 30), thread_id: "th-a", direction: "inbound", participants: JSON.stringify({ from: "+15550100", to: ["me"] }) },
  { id: "t-in-1", sent_at: local(2026, 9, 5), thread_id: "th-a", direction: "inbound", participants: JSON.stringify({ from: "+15550100", to: ["me"] }) },
  { id: "t-in-2", sent_at: local(2026, 9, 6), thread_id: "th-b", direction: "inbound", participants: JSON.stringify({ from: "+15550199", to: ["me"] }) },
  { id: "t-after", sent_at: local(2026, 9, 29), thread_id: "th-a", direction: "inbound", participants: JSON.stringify({ from: "+15550100", to: ["me"] }) },
];
const EMAILS: Row[] = [
  { id: "e-in", subject: "Contract", sent_at: local(2026, 9, 10) },
  // 18:00 local on the end date — inside (the window ends at the end of that day).
  { id: "e-endday", subject: "Closing docs", sent_at: local(2026, 9, 27, 18) },
  { id: "e-after-1", subject: "Final walk-through", sent_at: local(2026, 9, 28) },
  { id: "e-after-2", subject: "Keys", sent_at: local(2026, 9, 30) },
];
const ATTACHMENTS: Row[] = [
  { id: "a-1", email_id: "e-in", message_id: null, sent_at: local(2026, 9, 10), file_size_bytes: 1000, storage_path: "/x/a1" },
  { id: "a-2", email_id: null, message_id: "t-in-1", sent_at: local(2026, 9, 5), file_size_bytes: 500, storage_path: "/x/a2" },
  { id: "a-3", email_id: "e-after-1", message_id: null, sent_at: local(2026, 9, 28), file_size_bytes: 9, storage_path: "/x/a3" },
];

function windowed(rows: Row[]) {
  return (_id: string, start?: Date | null, end?: Date | null) => {
    const endBound = auditWindowEnd(end ?? null);
    return rows.filter(
      (r) =>
        (!start || (r.sent_at as string) >= start.toISOString()) &&
        (!endBound || (r.sent_at as string) <= endBound.toISOString())
    );
  };
}

const captured: { message: string; level?: string; extra?: unknown; tags?: unknown }[] = [];
const reporter = {
  captureException: () => undefined,
  captureMessage: (message: string, options?: { level?: string; tags?: unknown; extra?: unknown }) => {
    captured.push({ message, level: options?.level, tags: options?.tags, extra: options?.extra });
  },
  addBreadcrumb: () => undefined,
  flush: async () => true,
  setUser: () => undefined,
} as unknown as ErrorReporter;

const CANDIDATE = { started_at: "2026-09-01", closed_at: "2026-09-27" };

beforeEach(() => {
  jest.clearAllMocks();
  captured.length = 0;
  installErrorReporter(reporter);
  setPreflightStatForTests(async () => ({ size: 10 }));
  (supabaseService.getAuthSession as jest.Mock).mockResolvedValue({ userId: USER });
  (databaseService.getTransactionById as jest.Mock).mockResolvedValue({ id: TX, user_id: USER, ...CANDIDATE });
  (databaseService.getTransactionMessages as jest.Mock).mockImplementation(windowed(TEXTS));
  (databaseService.getTransactionEmails as jest.Mock).mockImplementation(windowed(EMAILS));
  (databaseService.getTransactionAttachments as jest.Mock).mockImplementation(windowed(ATTACHMENTS));
  (databaseService.getUndownloadedEmailAttachments as jest.Mock).mockReturnValue([]);
});

afterEach(() => {
  (auditPeriodFromRow as jest.Mock).mockReset();
  (auditPeriodFromRow as jest.Mock).mockImplementation(jest.requireActual("../submissionAuditPeriod").auditPeriodFromRow);
  resetErrorReporter();
  setPreflightStatForTests(null);
});

describe("BACKLOG-3683 — scope preview", () => {
  it("counts what the dates include; the end day counts until its end", async () => {
    const r = await submissionService.getSubmissionScope(TX, CANDIDATE);
    expect(r.success).toBe(true);
    expect(r.inWindow).toEqual({
      emails: 2,
      texts: 2,
      textThreads: 2,
      attachments: 2,
      emailAttachments: 1,
      attachmentBytes: 1500,
    });
    // Founder decision 2026-10-05: no out-of-window notice. The result
    // carries in-window counts only.
    expect(r).not.toHaveProperty("outOfWindow");
  });

  it("the preview's in-window set is the set the submit gathers for the same saved dates", async () => {
    const scope = await submissionService.getSubmissionScope(TX, CANDIDATE);
    (databaseService.getTransactionMessages as jest.Mock).mockClear();
    (databaseService.getTransactionEmails as jest.Mock).mockClear();
    await submissionService.preflightSubmission(TX);
    const gatheredTexts = (databaseService.getTransactionMessages as jest.Mock).mock.results[0].value as Row[];
    const gatheredEmails = (databaseService.getTransactionEmails as jest.Mock).mock.results[0].value as Row[];
    expect(gatheredTexts).toHaveLength(scope.inWindow!.texts);
    expect(gatheredEmails).toHaveLength(scope.inWindow!.emails);
  });

  /**
   * C2. MUTATION: inline `new Date(candidate.started_at)` / `closed_at` in
   * getSubmissionScope instead of calling auditPeriodFromRow → red.
   */
  it("C2: gather and preview both read the dates through auditPeriodFromRow", async () => {
    const sentinel = { auditStartDate: new Date("2001-01-01T00:00:00Z"), auditEndDate: new Date("2001-01-02T00:00:00Z") };
    (auditPeriodFromRow as jest.Mock).mockReturnValue(sentinel);
    await submissionService.getSubmissionScope(TX, CANDIDATE);
    await submissionService.preflightSubmission(TX);
    const calls = (databaseService.getTransactionMessages as jest.Mock).mock.calls;
    const windowedCalls = calls.filter((c) => c[1] !== null || c[2] !== null);
    expect(windowedCalls).toHaveLength(2);
    for (const c of windowedCalls) {
      expect(c[1]).toBe(sentinel.auditStartDate);
      expect(c[2]).toBe(sentinel.auditEndDate);
    }
  });

  it("one Sentry info with in-window counts only, no out-of-window data", async () => {
    await submissionService.getSubmissionScope(TX, CANDIDATE);
    const events = captured.filter((e) => e.message === "Submission scope previewed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "info",
      extra: expect.objectContaining({
        in_window: { emails: 2, texts: 2, textThreads: 2, attachments: 2 },
      }),
    });
    expect(events[0].extra).not.toHaveProperty("out_of_window");
    const blob = JSON.stringify(captured);
    for (const forbidden of ["Final walk-through", "Keys", "Contract", "Jane", "+1555"]) {
      expect({ forbidden, found: blob.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
  });
});
