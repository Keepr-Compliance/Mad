/**
 * BACKLOG-2771 — every export entry point routes through the ONE resolver.
 *
 * `exportPlan.test.ts` pins what the resolver decides. This suite pins that the
 * three IPC channels actually ASK it, rather than deciding for themselves:
 *
 *   - `transactions:export-folder`   (folder audit package)
 *   - `transactions:export-enhanced` (pdf / csv / excel / json / txt_eml)
 *   - `transactions:export-pdf`      (orphan channel, no renderer caller)
 *
 * ## The control this file exists for
 *
 * Before this refactor the BACKLOG-2343 audit-window boundary was written out
 * twice and absent a third time, so a mutation to one copy left the other
 * formats green. Mutating the `+ 1` in `auditWindowEnd()` must now red the
 * closing-day assertions of EVERY format that has an audit window, together.
 * (`transactions:export-pdf` requests no window at all — by design, since it
 * takes no options — so it is asserted for full-record pass-through instead of
 * a boundary it does not have.)
 *
 * The export services are mocked, so what these tests observe is the PLAN each
 * handler hands its renderer — which is exactly the decision under test.
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";
import type { Communication } from "../types/models";
import type { TransactionWithDetails } from "../services/transactionService/types";
import type { ExportPlan } from "../services/exportPlan";

const mockIpcHandle = jest.fn();

jest.mock("electron", () => ({
  ipcMain: { handle: mockIpcHandle },
  BrowserWindow: jest.fn(),
}));

const mockGetTransactionDetails = jest.fn();

jest.mock("../services/transactionService", () => ({
  __esModule: true,
  default: { getTransactionDetails: (...a: unknown[]) => mockGetTransactionDetails(...a) },
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const mockExportToFolder = jest.fn().mockResolvedValue("/exports/transaction");
const mockExportToCombinedPDF = jest.fn().mockResolvedValue("/exports/report.pdf");

jest.mock("../services/folderExportService", () => ({
  __esModule: true,
  default: {
    getDefaultExportPath: jest.fn().mockReturnValue("/exports/transaction"),
    exportTransactionToFolder: (...a: unknown[]) => mockExportToFolder(...a),
    exportTransactionToCombinedPDF: (...a: unknown[]) => mockExportToCombinedPDF(...a),
  },
}));

const mockEnhancedExport = jest.fn().mockResolvedValue("/exports/report.json");

jest.mock("../services/enhancedExportService", () => ({
  __esModule: true,
  default: { exportTransaction: (...a: unknown[]) => mockEnhancedExport(...a) },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    updateTransaction: jest.fn().mockResolvedValue(undefined),
    stampFirstExportedAt: jest.fn().mockReturnValue(true),
  },
}));

// The paywall gate is UNLOCKED here (it has its own suite) and returns the
// communications unchanged, matching production Option A.
jest.mock("../services/exportGate", () => ({
  __esModule: true,
  PaywallLockedError: class PaywallLockedError extends Error {},
  enforceExportGate: jest.fn(async ({ communications }: { communications: unknown[] }) => ({
    decision: { allowed: true, mode: "full" },
    communications,
  })),
  emitExportCompleted: jest.fn().mockResolvedValue(undefined),
}));

// The two awaited completeness backstops (BACKLOG-1802 / BACKLOG-2292) are
// no-ops here; they run before the include set is resolved.
jest.mock("../services/transactionSyncTrigger", () => ({
  __esModule: true,
  ensureTransactionEmailsSynced: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/messagesSyncTrigger", () => ({
  __esModule: true,
  ensureTransactionMessagesSynced: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/submissionService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/submissionSyncService", () => ({
  __esModule: true,
  default: { stopAllSync: jest.fn() },
}));
jest.mock("../services/supabaseService", () => ({ __esModule: true, default: {} }));

import { registerTransactionExportHandlers } from "../handlers/transactionExportHandlers";

// --- Fixtures ---------------------------------------------------------------

const TX_ID = "550e8400-e29b-41d4-a716-446655440001";
const USER_ID = "550e8400-e29b-41d4-a716-446655440000";

/**
 * The founder repro from BACKLOG-2343, transcribed: a text sent Jul 28 late
 * evening America/Chicago (UTC-5) is stored with a UTC sent_at that has already
 * rolled into Jul 29 — the audit window's closing day.
 */
const CLOSING_DAY_TEXT: Communication = {
  id: "closing-day-text",
  sent_at: "2026-07-29T04:30:00Z",
  communication_type: "sms",
  channel: "sms",
} as unknown as Communication;

const IN_WINDOW_EMAIL: Communication = {
  id: "in-window-email",
  sent_at: "2026-03-01T10:00:00Z",
  communication_type: "email",
  channel: "email",
  subject: "Inspection",
} as unknown as Communication;

const OUT_OF_WINDOW_EMAIL: Communication = {
  id: "out-of-window-email",
  sent_at: "2026-09-01T10:00:00Z",
  communication_type: "email",
  channel: "email",
  subject: "Long after closing",
} as unknown as Communication;

const ALL_COMMS = [IN_WINDOW_EMAIL, CLOSING_DAY_TEXT, OUT_OF_WINDOW_EMAIL];

const details = (): TransactionWithDetails =>
  ({
    id: TX_ID,
    user_id: USER_ID,
    property_address: "27 Closing Day Lane",
    started_at: "2026-01-01",
    closed_at: "2026-07-29",
    first_exported_at: null,
    export_count: 0,
    communications: [...ALL_COMMS],
    contact_assignments: [],
  }) as unknown as TransactionWithDetails;

const ids = (comms: Communication[]): string[] => comms.map((c) => c.id as string);

describe("BACKLOG-2771: every export entry point resolves its include set once", () => {
  let handlers: IpcHandlerRegistry;
  const event = {} as IpcMainInvokeEvent;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: unknown) => {
      handlers.set(channel, handler as never);
    });
    mockGetTransactionDetails.mockResolvedValue(details());
    registerTransactionExportHandlers(null);
  });

  /** The plan `transactions:export-folder` handed folderExportService. */
  const folderPlan = (): ExportPlan => mockExportToFolder.mock.calls[0][1] as ExportPlan;

  /** The plan `transactions:export-enhanced` handed enhancedExportService. */
  const enhancedPlan = (): ExportPlan => mockEnhancedExport.mock.calls[0][1] as ExportPlan;

  describe("the BACKLOG-2343 closing-day boundary, asserted at every entry point", () => {
    it("folder export keeps the closing-day text and drops the post-closing email", async () => {
      await handlers.get("transactions:export-folder")(event, TX_ID, {
        contentType: "both",
        attachmentType: "all",
      });

      expect(mockExportToFolder).toHaveBeenCalledTimes(1);
      expect(ids(folderPlan().communications)).toEqual([
        IN_WINDOW_EMAIL.id as string,
        CLOSING_DAY_TEXT.id as string,
      ]);
    });

    it("enhanced export keeps the closing-day text and drops the post-closing email", async () => {
      await handlers.get("transactions:export-enhanced")(event, TX_ID, {
        exportFormat: "json",
        contentType: "both",
      });

      expect(mockEnhancedExport).toHaveBeenCalledTimes(1);
      expect(ids(enhancedPlan().communications)).toEqual([
        IN_WINDOW_EMAIL.id as string,
        CLOSING_DAY_TEXT.id as string,
      ]);
    });

    it("enhanced export honors an EXPLICIT window from the wire over the transaction's", async () => {
      // The window lives in the REQUEST, not in a second filter: this entry
      // point prefers the option dates, the folder one has none to prefer.
      await handlers.get("transactions:export-enhanced")(event, TX_ID, {
        exportFormat: "json",
        contentType: "both",
        startDate: "2026-01-01",
        endDate: "2026-07-28",
      });

      // One day earlier: the closing-day text now falls outside.
      expect(ids(enhancedPlan().communications)).toEqual([IN_WINDOW_EMAIL.id as string]);
    });

    it("the orphan export-pdf channel requests no window and exports the full record", async () => {
      // `window.api.transactions.exportPDF` has no caller in src/ and the channel
      // takes no options, so it states an empty request rather than inheriting
      // one. Behavior is unchanged from when it had no filtering at all.
      await handlers.get("transactions:export-pdf")(event, TX_ID, "/tmp/out.pdf");

      expect(mockExportToCombinedPDF).toHaveBeenCalledTimes(1);
      expect(ids(mockExportToCombinedPDF.mock.calls[0][1] as Communication[])).toEqual(
        ids(ALL_COMMS),
      );
    });
  });

  describe("content selection speaks ONE vocabulary", () => {
    it("folder export narrows to texts", async () => {
      await handlers.get("transactions:export-folder")(event, TX_ID, {
        contentType: "texts",
        attachmentType: "all",
      });

      expect(ids(folderPlan().communications)).toEqual([CLOSING_DAY_TEXT.id as string]);
      expect(folderPlan().includeEmails).toBe(false);
      expect(folderPlan().includeTexts).toBe(true);
    });

    it("enhanced export accepts the SAME spelling the folder channel uses", async () => {
      // Before BACKLOG-2771 this channel required "texts" to be spelled "text",
      // and the ExportModal translated at the call site.
      await handlers.get("transactions:export-enhanced")(event, TX_ID, {
        exportFormat: "json",
        contentType: "texts",
      });

      expect(ids(enhancedPlan().communications)).toEqual([CLOSING_DAY_TEXT.id as string]);
    });

    it("enhanced export still understands the RETIRED spelling from an older renderer", async () => {
      // The compiler rejects it, but a renderer from a previous build can still
      // put it on the wire; the boundary normalizer maps it rather than
      // widening the export to "both".
      await handlers.get("transactions:export-enhanced")(event, TX_ID, {
        exportFormat: "json",
        contentType: "text",
      });

      expect(ids(enhancedPlan().communications)).toEqual([CLOSING_DAY_TEXT.id as string]);
    });

    it("folder export returns the narrowed-selection message when nothing matches", async () => {
      mockGetTransactionDetails.mockResolvedValue({
        ...details(),
        communications: [IN_WINDOW_EMAIL],
      });

      const result = await handlers.get("transactions:export-folder")(event, TX_ID, {
        contentType: "texts",
        attachmentType: "all",
      });

      expect(result).toEqual({
        success: false,
        error: "No text communications found for this transaction in the selected date range.",
      });
      expect(mockExportToFolder).not.toHaveBeenCalled();
    });
  });

  describe("SHIPPED wire defaults for options the payload omits", () => {
    /*
     * BACKLOG-2771 (SR review of PR #2335): these three defaults were entirely
     * unpinned. Flipping ALL of them at once — the folder wire's "all", the
     * enhanced wire's "none", and normalizeEmailMode's "thread" — left 161
     * tests across 8 suites green.
     *
     * The nearest-looking existing case, folderExportService.test.ts's
     * "defaults to Thread View when emailExportMode is omitted", could not have
     * caught it: after the plan migration it omits `emailMode` from the FIXTURE
     * HELPER, whose own default supplies "thread" before the shipped normalizer
     * is ever reached. It has been renamed accordingly.
     *
     * These assertions drive the real handlers with real wire payloads, so the
     * shipped defaults are the only thing that can satisfy them.
     */

    it("folder: an omitted emailExportMode defaults to THREAD grouping", async () => {
      await handlers.get("transactions:export-folder")(event, TX_ID, {
        contentType: "both",
        attachmentType: "all",
        // emailExportMode deliberately absent
      });

      expect(folderPlan().emailRenderMode).toBe("thread");
    });

    it("folder: an omitted attachmentType defaults to ALL — attachments are PRESERVED", async () => {
      // The safe default for the audit package is to keep the evidence. A
      // caller that says nothing about attachments must not silently get none.
      await handlers.get("transactions:export-folder")(event, TX_ID, {
        contentType: "both",
        // attachmentType deliberately absent
      });

      expect(folderPlan().writesAttachmentsToDisk).toBe(true);
      expect(ids(folderPlan().attachmentComms)).toEqual([
        IN_WINDOW_EMAIL.id as string,
        CLOSING_DAY_TEXT.id as string,
      ]);
    });

    it("enhanced: an omitted attachmentType defaults to NONE — the asymmetry with folder is deliberate", async () => {
      // Load-bearing asymmetry, pinned on BOTH sides so neither drifts to match
      // the other. A single-file artifact (csv/json/txt_eml, or a PDF) is not an
      // evidence package: writing an attachments folder beside it for a caller
      // that never asked is a surprise, and for the PDF path it would also pull
      // declined attachments from Gmail/Outlook (the BACKLOG-2769 failure mode).
      await handlers.get("transactions:export-enhanced")(event, TX_ID, {
        exportFormat: "pdf",
        contentType: "both",
        // attachmentType deliberately absent
      });

      expect(enhancedPlan().writesAttachmentsToDisk).toBe(false);
      expect(enhancedPlan().attachmentComms).toEqual([]);
    });

    it("enhanced: an omitted emailExportMode defaults to THREAD grouping", async () => {
      await handlers.get("transactions:export-enhanced")(event, TX_ID, {
        exportFormat: "pdf",
        contentType: "both",
      });

      expect(enhancedPlan().emailRenderMode).toBe("thread");
    });

    it("ANTI-VACUITY: an EXPLICIT value on the wire still overrides each default", async () => {
      // Without this, every assertion above would also pass against a handler
      // that ignored the wire and hard-coded the default.
      await handlers.get("transactions:export-folder")(event, TX_ID, {
        contentType: "both",
        attachmentType: "none",
        emailExportMode: "individual",
      });

      expect(folderPlan().emailRenderMode).toBe("individual");
      expect(folderPlan().writesAttachmentsToDisk).toBe(false);
    });
  });

  describe('CONTROL: attachmentType "none" reaches every renderer as "write nothing"', () => {
    it("folder export", async () => {
      await handlers.get("transactions:export-folder")(event, TX_ID, {
        contentType: "both",
        attachmentType: "none",
      });

      expect(folderPlan().writesAttachmentsToDisk).toBe(false);
      expect(folderPlan().attachmentComms).toEqual([]);
    });

    it("enhanced PDF export", async () => {
      await handlers.get("transactions:export-enhanced")(event, TX_ID, {
        exportFormat: "pdf",
        contentType: "both",
        attachmentType: "none",
      });

      expect(enhancedPlan().writesAttachmentsToDisk).toBe(false);
      expect(enhancedPlan().attachmentComms).toEqual([]);
    });

    it("the orphan export-pdf channel", async () => {
      await handlers.get("transactions:export-pdf")(event, TX_ID, "/tmp/out.pdf");
      // This channel has no attachment phase at all; it renders the combined PDF
      // only. Its plan says so rather than leaving it implicit.
      expect(mockExportToCombinedPDF).toHaveBeenCalledTimes(1);
    });

    it("anti-vacuity: the same handlers DO select attachments when asked", async () => {
      await handlers.get("transactions:export-folder")(event, TX_ID, {
        contentType: "both",
        attachmentType: "all",
      });

      expect(folderPlan().writesAttachmentsToDisk).toBe(true);
      expect(ids(folderPlan().attachmentComms)).toEqual([
        IN_WINDOW_EMAIL.id as string,
        CLOSING_DAY_TEXT.id as string,
      ]);
    });

    it("a summary-only PDF writes no attachments even when the user selected all", async () => {
      await handlers.get("transactions:export-enhanced")(event, TX_ID, {
        exportFormat: "pdf",
        contentType: "both",
        attachmentType: "all",
        summaryOnly: true,
      });

      expect(enhancedPlan().writesAttachmentsToDisk).toBe(false);
      expect(enhancedPlan().attachmentComms).toEqual([]);
    });
  });
});
