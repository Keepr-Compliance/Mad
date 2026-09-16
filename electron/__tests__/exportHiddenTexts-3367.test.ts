/**
 * BACKLOG-3367 — every export HANDLER hands its renderer a plan that omits the
 * hidden texts AND states how many it omitted.
 *
 * `exportPlanHiddenTexts-3367.test.ts` pins what the resolver decides. This
 * suite pins what each IPC channel actually hands over — which is where the one
 * defect this item was most likely to ship lives.
 *
 * ## The control this file exists for (P7)
 *
 * `transactions:export-folder` used to resolve the include set, run the paywall
 * gate, then resolve AGAIN over the gate's output — which is the
 * already-resolved list, because Option A returns its input unchanged
 * (`exportGate.ts`). That is harmless while a plan carries only MEMBERSHIP, and
 * silently wrong the moment it carries a COUNT OF WHAT WAS REMOVED: the second
 * pass sees a set with no hidden texts left in it and reports 0, and the second
 * plan is the one the renderer receives. Measured at plan review before any of
 * this existed — folder 0 against enhanced 1 for the same transaction
 * (pm_comments d590f7c6, SR mutation M1).
 *
 * So the folder and enhanced channels are asserted TOGETHER on the same input.
 * A fix applied to one and not the other, or a regression to the double
 * resolve, separates them here and nowhere else.
 *
 * The mock block below is the one from `exportIncludeSet-2771.test.ts`,
 * deliberately copied rather than shared: its gate mock returns its input
 * unchanged, which is exactly the production behaviour that made the double
 * resolve invisible.
 *
 * `transactions:export-pdf` is NOT covered. It has no caller in `src/` and the
 * founder ruled it deleted on 2026-09-12 (BACKLOG-3234 → BACKLOG-3302); the
 * resolver filter reaches it for free and nothing was built for it.
 */

import { randomUUID } from "crypto";
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

const mockAuditLog = jest.fn().mockResolvedValue(undefined);

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: (...a: unknown[]) => mockAuditLog(...a) },
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
    recordExportCompletion: jest.fn().mockReturnValue(true),
  },
}));

// The paywall gate is UNLOCKED here and returns the communications unchanged,
// matching production Option A. This is the behaviour that hid the bug P7 holds.
jest.mock("../services/exportGate", () => ({
  __esModule: true,
  PaywallLockedError: class PaywallLockedError extends Error {},
  enforceExportGate: jest.fn(async ({ communications }: { communications: unknown[] }) => ({
    decision: { allowed: true, mode: "full" },
    communications,
  })),
  emitExportCompleted: jest.fn().mockResolvedValue(undefined),
}));

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

// Generated per run, never written into the repository. The handler validates
// its transaction id as a UUID, so the shape matters and the value does not —
// and a UUID committed to a PUBLIC repo has no shape that tells an invented one
// from a live row (the fixture PII guard refuses to guess, correctly).
const TX_ID: string = randomUUID();
const USER_ID: string = randomUUID();

/** A text row as `getCommunicationsWithMessages` projects it (marker is 0|1). */
function text(id: string, sentAt: string, hidden: 0 | 1): Communication {
  return {
    id,
    communication_type: "imessage",
    channel: "imessage",
    body_text: `body of ${id}`,
    sent_at: sentAt,
    external_id: `guid-${id}`,
    associated_message_type: null,
    associated_message_guid: null,
    hidden_from_export: hidden,
  } as unknown as Communication;
}

const HIDDEN_A = text("hidden-a", "2026-03-10T10:00:00Z", 1);
const HIDDEN_B = text("hidden-b", "2026-03-11T10:00:00Z", 1);
const VISIBLE = text("visible", "2026-03-12T10:00:00Z", 0);

const IN_WINDOW_EMAIL: Communication = {
  id: "in-window-email",
  sent_at: "2026-03-01T10:00:00Z",
  communication_type: "email",
  channel: "email",
  subject: "Inspection",
  hidden_from_export: 0,
} as unknown as Communication;

const details = (comms: Communication[]): TransactionWithDetails =>
  ({
    id: TX_ID,
    user_id: USER_ID,
    property_address: "27 Closing Day Lane",
    started_at: "2026-01-01",
    closed_at: "2026-12-31",
    first_exported_at: null,
    export_count: 0,
    communications: comms,
    contact_assignments: [],
  }) as unknown as TransactionWithDetails;

const ids = (comms: Communication[]): string[] => comms.map((c) => c.id as string);

describe("BACKLOG-3367: every export handler omits hidden texts and states the count", () => {
  let handlers: IpcHandlerRegistry;
  const event = {} as IpcMainInvokeEvent;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = createIpcHandlerRegistry();
    mockIpcHandle.mockImplementation((channel: string, handler: unknown) => {
      handlers.set(channel, handler as never);
    });
    registerTransactionExportHandlers(null);
  });

  const folderPlan = (): ExportPlan => mockExportToFolder.mock.calls[0][1] as ExportPlan;
  const enhancedPlan = (): ExportPlan => mockEnhancedExport.mock.calls[0][1] as ExportPlan;

  const runFolder = (options: Record<string, unknown> = {}) =>
    handlers.get("transactions:export-folder")(event, TX_ID, {
      contentType: "both",
      attachmentType: "all",
      ...options,
    });

  const runEnhanced = (options: Record<string, unknown> = {}) =>
    handlers.get("transactions:export-enhanced")(event, TX_ID, {
      exportFormat: "json",
      contentType: "both",
      ...options,
    });

  describe("P6 — the omission happens for BOTH live channels, not one renderer", () => {
    it("the folder plan excludes the hidden texts", async () => {
      mockGetTransactionDetails.mockResolvedValue(
        details([HIDDEN_A, VISIBLE, IN_WINDOW_EMAIL, HIDDEN_B]),
      );

      await runFolder();

      expect(mockExportToFolder).toHaveBeenCalledTimes(1);
      expect(ids(folderPlan().communications)).toEqual(["visible", "in-window-email"]);
    });

    it("the enhanced plan excludes the hidden texts", async () => {
      mockGetTransactionDetails.mockResolvedValue(
        details([HIDDEN_A, VISIBLE, IN_WINDOW_EMAIL, HIDDEN_B]),
      );

      await runEnhanced();

      expect(mockEnhancedExport).toHaveBeenCalledTimes(1);
      expect(ids(enhancedPlan().communications)).toEqual(["visible", "in-window-email"]);
    });
  });

  describe("P7 — the folder plan's count is the one the renderer receives", () => {
    it("folder and enhanced report the SAME count for the same transaction", async () => {
      mockGetTransactionDetails.mockResolvedValue(
        details([HIDDEN_A, VISIBLE, IN_WINDOW_EMAIL, HIDDEN_B]),
      );

      await runFolder();
      await runEnhanced();

      // The discriminating assertion. With the double resolve restored, the
      // folder side reads 0 while the enhanced side reads 2 — and the artifact
      // the user opens is the folder one.
      expect(folderPlan().hiddenTextCount).toBe(2);
      expect(enhancedPlan().hiddenTextCount).toBe(2);
      expect(folderPlan().hiddenTextCount).toBe(enhancedPlan().hiddenTextCount);
    });

    it("the folder plan carries the hidden ROWS, for the per-conversation counts", async () => {
      mockGetTransactionDetails.mockResolvedValue(
        details([HIDDEN_A, VISIBLE, IN_WINDOW_EMAIL, HIDDEN_B]),
      );

      await runFolder();

      expect(ids(folderPlan().hiddenTexts)).toEqual(["hidden-a", "hidden-b"]);
    });

    it("both channels report 0 when nothing is hidden", async () => {
      mockGetTransactionDetails.mockResolvedValue(details([VISIBLE, IN_WINDOW_EMAIL]));

      await runFolder();
      await runEnhanced();

      expect(folderPlan().hiddenTextCount).toBe(0);
      expect(enhancedPlan().hiddenTextCount).toBe(0);
    });
  });

  describe("the audit log records what the artifact left out", () => {
    it("the folder export's DATA_EXPORT entry carries the count", async () => {
      mockGetTransactionDetails.mockResolvedValue(details([HIDDEN_A, VISIBLE, HIDDEN_B]));

      await runFolder();

      const dataExport = mockAuditLog.mock.calls
        .map((c) => c[0] as { action: string; metadata?: { hiddenTextCount?: number } })
        .find((c) => c.action === "DATA_EXPORT");
      expect(dataExport?.metadata?.hiddenTextCount).toBe(2);
    });

    it("the enhanced export's DATA_EXPORT entry carries the count", async () => {
      mockGetTransactionDetails.mockResolvedValue(details([HIDDEN_A, VISIBLE, HIDDEN_B]));

      await runEnhanced();

      const dataExport = mockAuditLog.mock.calls
        .map((c) => c[0] as { action: string; metadata?: { hiddenTextCount?: number } })
        .find((c) => c.action === "DATA_EXPORT");
      expect(dataExport?.metadata?.hiddenTextCount).toBe(2);
    });
  });

  describe("P10 — an all-hidden selection says so, rather than 'none found'", () => {
    it("texts-only, every in-window text hidden: the message names hiding", async () => {
      mockGetTransactionDetails.mockResolvedValue(
        details([HIDDEN_A, HIDDEN_B, IN_WINDOW_EMAIL]),
      );

      const result = await runFolder({ contentType: "texts" });

      expect(result).toEqual({
        success: false,
        error: "All 2 texts in the selected date range are hidden from export.",
      });
      expect(mockExportToFolder).not.toHaveBeenCalled();
    });

    it("texts-only, the single in-window text hidden: singular wording", async () => {
      mockGetTransactionDetails.mockResolvedValue(details([HIDDEN_A, IN_WINDOW_EMAIL]));

      const result = await runFolder({ contentType: "texts" });

      expect(result).toEqual({
        success: false,
        error: "The only text in the selected date range is hidden from export.",
      });
    });

    it("texts-only with no texts at all: the ORIGINAL message, unchanged", async () => {
      // The pre-3367 wording must survive for the case it was written for —
      // otherwise this control would pass on a build that replaced the message
      // unconditionally and lied in the other direction.
      mockGetTransactionDetails.mockResolvedValue(details([IN_WINDOW_EMAIL]));

      const result = await runFolder({ contentType: "texts" });

      expect(result).toEqual({
        success: false,
        error:
          "No text communications found for this transaction in the selected date range.",
      });
    });
  });
});
