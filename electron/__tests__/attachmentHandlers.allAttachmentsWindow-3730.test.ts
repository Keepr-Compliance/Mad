/**
 * @jest-environment node
 *
 * BACKLOG-3730 — the Attachments tab's window is the submission's window.
 *
 * The tab hands `transactions:get-all-attachments` the transaction's raw
 * `started_at` / `closed_at`. The handler must turn them into the window
 * through `auditPeriodFromRow` — the one reader the submit gather and the
 * scope preview use (BACKLOG-3683) — and hand exactly that result to the
 * query. The query's own boundary (`sent_at >= start`, `<= auditWindowEnd(end)`)
 * is pinned against the submit's by the two closingDay-2781 suites.
 *
 * Control: give the handler its own `new Date(...)` again instead of calling
 * `auditPeriodFromRow` → the sentinel never reaches the query → red.
 */
import type { IpcMainInvokeEvent } from "electron";
import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
} from "../../tests/support/ipcHandlerRegistry";

const registeredHandlers: IpcHandlerRegistry = createIpcHandlerRegistry();
const mockGetTransactionAllAttachments = jest.fn((..._args: unknown[]) => [] as unknown[]);

jest.mock("electron", () => ({
  ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp") },
  shell: { openPath: jest.fn() },
  net: { fetch: jest.fn() },
}));

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getTransactionAllAttachments: (...args: unknown[]) => mockGetTransactionAllAttachments(...args),
    isInitialized: jest.fn(() => true),
  },
}));

jest.mock("../services/submissionAuditPeriod", () => {
  const actual = jest.requireActual("../services/submissionAuditPeriod");
  return { ...actual, auditPeriodFromRow: jest.fn(actual.auditPeriodFromRow) };
});

jest.mock("../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { logAction: jest.fn(), log: jest.fn() },
}));
jest.mock("../services/emailAttachmentService", () => ({
  __esModule: true,
  default: { getAttachmentsForEmail: jest.fn(() => Promise.resolve([])) },
}));
jest.mock("../services/emailAttachmentBackfillService", () => ({
  backfillAttachmentMetadata: jest.fn(),
}));
jest.mock("../services/attachmentTextExtractionBackfillService", () => ({
  backfillAttachmentTextContent: jest.fn(),
}));
jest.mock("../services/gmailFetchService", () => ({
  __esModule: true,
  default: { fetchAttachment: jest.fn() },
}));
jest.mock("../services/outlookFetchService", () => ({
  __esModule: true,
  default: { fetchAttachment: jest.fn() },
}));
jest.mock("../services/featureGateService", () => ({
  __esModule: true,
  default: { canUseFeature: jest.fn(() => true) },
}));
jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: { getClient: jest.fn() },
}));
jest.mock("../services/db/emailDbService", () => ({
  getEmailById: jest.fn(),
}));

import { registerAttachmentHandlers } from "../handlers/attachmentHandlers";
import { auditPeriodFromRow } from "../services/submissionAuditPeriod";

const TXN_ID = "11111111-1111-4111-8111-111111111111"; // pii-allow-uuid: invented fixture, not from any live row

async function invoke(auditStart?: string, auditEnd?: string) {
  const handler = registeredHandlers.get("transactions:get-all-attachments");
  const result = (await handler({} as IpcMainInvokeEvent, TXN_ID, auditStart, auditEnd)) as {
    success: boolean;
    error?: string;
  };
  if (!result.success) throw new Error(`handler failed: ${result.error ?? "no error message"}`);
  return result;
}

describe("transactions:get-all-attachments — window read through auditPeriodFromRow (BACKLOG-3730)", () => {
  beforeEach(() => {
    mockGetTransactionAllAttachments.mockClear();
    (auditPeriodFromRow as jest.Mock).mockReset();
    (auditPeriodFromRow as jest.Mock).mockImplementation(
      jest.requireActual("../services/submissionAuditPeriod").auditPeriodFromRow,
    );
    registeredHandlers.clear();
    registerAttachmentHandlers(null);
  });

  it("C1: hands the query exactly what auditPeriodFromRow returns for the raw dates", async () => {
    const sentinel = {
      auditStartDate: new Date("2001-02-03T04:05:06.000Z"),
      auditEndDate: new Date("2002-03-04T05:06:07.000Z"),
    };
    (auditPeriodFromRow as jest.Mock).mockReturnValue(sentinel);

    await invoke("2026-01-01", "2026-07-29");

    expect(auditPeriodFromRow).toHaveBeenCalledWith({
      started_at: "2026-01-01",
      closed_at: "2026-07-29",
    });
    expect(mockGetTransactionAllAttachments).toHaveBeenCalledTimes(1);
    const [, start, end] = mockGetTransactionAllAttachments.mock.calls[0];
    expect(start).toBe(sentinel.auditStartDate);
    expect(end).toBe(sentinel.auditEndDate);
  });

  it("C2: no dates → no window (the 'show all' list)", async () => {
    await invoke(undefined, undefined);
    const [, start, end] = mockGetTransactionAllAttachments.mock.calls[0];
    expect(start).toBeNull();
    expect(end).toBeNull();
  });

  it("C3: with the real reader, the raw strings become the same Dates the submit builds", async () => {
    await invoke("2026-01-01", "2026-07-29");
    const [, start, end] = mockGetTransactionAllAttachments.mock.calls[0] as [string, Date, Date];
    const expected = jest
      .requireActual("../services/submissionAuditPeriod")
      .auditPeriodFromRow({ started_at: "2026-01-01", closed_at: "2026-07-29" });
    expect(start.getTime()).toBe(expected.auditStartDate.getTime());
    expect(end.getTime()).toBe(expected.auditEndDate.getTime());
  });
});
