/**
 * BACKLOG-3302 (SR draft control) — the "One PDF" and "Summary PDF" buttons go
 * through `transactions:export-enhanced` into enhancedExportService's PDF
 * branch, which hands the combined renderer its communications and its
 * summaryOnly flag. Nothing else pins that hand-off at unit level.
 *
 * The REAL handler and the REAL enhancedExportService run; only the combined
 * renderer (and I/O around it) is mocked, so the assertion is on what the live
 * path actually passes it. Payloads are transcribed from
 * `src/components/ExportModal.tsx` runExportCall (:335-346).
 */

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";
import type { Communication } from "../types/models";
import type { TransactionWithDetails } from "../services/transactionService/types";

const mockIpcHandle = jest.fn();
const DOWNLOADS = "/tmp/keepr-3302-downloads";

jest.mock("electron", () => ({
  ipcMain: { handle: mockIpcHandle },
  BrowserWindow: jest.fn(),
  app: { getPath: jest.fn(() => DOWNLOADS) },
}));

const mockGetTransactionDetails = jest.fn();
jest.mock("../services/transactionService", () => ({
  __esModule: true,
  default: { getTransactionDetails: (...a: unknown[]) => mockGetTransactionDetails(...a) },
}));
jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: {
    log: jest.fn().mockResolvedValue(undefined),
    recordInTransaction: jest.fn(),
    recordFailure: jest.fn(),
  },
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
}));
// The database is mocked, so the completion transaction just runs its body.
jest.mock("../services/db/core/dbConnection", () => ({
  ...jest.requireActual("../services/db/core/dbConnection"),
  dbTransaction: (fn: () => unknown) => fn(),
}));
jest.mock("../services/logService", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

const mockExportToCombinedPDF = jest.fn(async (_t: unknown, _c: unknown, out: string) => out);
jest.mock("../services/folderExportService", () => ({
  __esModule: true,
  default: {
    getDefaultExportPath: jest.fn().mockReturnValue("/exports/transaction"),
    exportTransactionToFolder: jest.fn(),
    exportTransactionToCombinedPDF: (...a: unknown[]) =>
      mockExportToCombinedPDF(...(a as [unknown, unknown, string])),
    exportAttachments: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../services/emailAttachmentDownload", () => ({
  __esModule: true,
  downloadMissingEmailAttachments: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("fs/promises", () => ({
  __esModule: true,
  default: { mkdir: jest.fn().mockResolvedValue(undefined), writeFile: jest.fn() },
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn(),
}));
jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    updateTransaction: jest.fn().mockResolvedValue(undefined),
    recordExportCompletion: jest.fn(),
  },
}));
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

const TX_ID = "00000000-0000-0000-0000-000000000001"; // pii-allow-uuid: invented fixture id, not from any live row
const USER_ID = "00000000-0000-0000-0000-000000000002"; // pii-allow-uuid: invented fixture id, not from any live row

const email = (id: string, sentAt: string): Communication =>
  ({
    id,
    sent_at: sentAt,
    communication_type: "email",
    channel: "email",
    subject: `Subject ${id}`,
    body_plain: `Body ${id}`,
  }) as unknown as Communication;

const IN_WINDOW = [email("e1", "2026-01-05T17:00:00Z"), email("e2", "2026-02-14T19:00:00Z")];
const OUT_OF_WINDOW = email("late", "2026-09-01T10:00:00Z");

const details = (): TransactionWithDetails =>
  ({
    id: TX_ID,
    user_id: USER_ID,
    property_address: "742 Plan Lane",
    started_at: "2026-01-01",
    closed_at: "2026-07-29",
    first_exported_at: null,
    export_count: 0,
    communications: [...IN_WINDOW, OUT_OF_WINDOW],
    contact_assignments: [],
  }) as unknown as TransactionWithDetails;

/** ExportModal.tsx runExportCall, `exportFormat === "combined-pdf"` ("One PDF"). */
const onePdf = (attachmentType: "all" | "none") => ({
  exportFormat: "pdf",
  contentType: "both",
  startDate: "2026-01-01",
  endDate: "2026-07-29",
  summaryOnly: false,
  attachmentType,
  emailExportMode: "thread",
  includeChecklist: false,
});

describe("BACKLOG-3302: the One PDF / Summary PDF buttons hand the combined renderer the right payload", () => {
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

  const rendered = () => {
    expect(mockExportToCombinedPDF).toHaveBeenCalledTimes(1);
    const [, comms, out, , summaryOnly] = mockExportToCombinedPDF.mock.calls[0] as unknown as [
      unknown,
      Communication[],
      string,
      unknown,
      boolean,
    ];
    return { ids: comms.map((c) => c.id).sort(), out, summaryOnly };
  };

  it.each(["none", "all"] as const)(
    "One PDF (attachments %s): full content, every in-window communication, not a summary",
    async (attachmentType) => {
      const result = (await handlers.get("transactions:export-enhanced")(
        event,
        TX_ID,
        onePdf(attachmentType),
      )) as { success: boolean };
      expect(result).toEqual(expect.objectContaining({ success: true }));
      const r = rendered();
      expect(r.summaryOnly).toBe(false);
      expect(r.ids).toEqual(["e1", "e2"]);
      expect(r.out.startsWith(`${DOWNLOADS}/`)).toBe(true);
    },
  );

  it("Summary PDF: the same channel, summaryOnly true — so the flag above is discriminating", async () => {
    await handlers.get("transactions:export-enhanced")(event, TX_ID, {
      ...onePdf("all"),
      summaryOnly: true,
    });
    expect(rendered().summaryOnly).toBe(true);
  });
});
