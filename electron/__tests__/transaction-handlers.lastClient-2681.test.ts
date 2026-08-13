/**
 * @jest-environment node
 *
 * BACKLOG-2681 — control 2: the refusal is NOT renderer-only.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE PROVES THAT THE UNIT TEST CANNOT
 * ---------------------------------------------------------------------------
 * The item's control 2 is that *"the same end state reached through
 * `transactions:batchUpdateContacts` directly gets the same answer — proving
 * the rule is not renderer-only."*
 *
 * So this drives the REGISTERED IPC HANDLER, with the REAL `transactionService`
 * behind it. Only `databaseService` is mocked, because the rule reads the
 * transaction's current rows through it and writes through it.
 *
 * A test that mocked `transactionService` — which is what
 * `transaction-handlers.test.ts` does, correctly, for its own purposes — would
 * pass whether or not the rule existed. It is the mock boundary, not the
 * assertion, that decides whether this control can fail.
 *
 * The leg that matters most is `does not reach the database`: a rule that threw
 * AFTER the write would satisfy every "it was refused" assertion while having
 * already corrupted the deal.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IpcMainInvokeEvent } from "electron";

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: () => "/tmp" },
}));

let currentRows: Array<{ contact_id: string; role?: string | null; specific_role?: string | null }> =
  [];
const batchWrite = jest.fn(() => Promise.resolve());

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getTransactionContactsWithRoles: jest.fn(() => Promise.resolve(currentRows)),
    batchUpdateContactAssignments: (...args: unknown[]) => batchWrite(...(args as [])),
    getTransactionById: jest.fn(() => Promise.resolve(null)),
    isInitialized: jest.fn(() => true),
  },
}));

jest.mock("../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), logTransactionAction: jest.fn(), logContactAction: jest.fn() },
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../services/autoLinkService", () => ({
  __esModule: true,
  autoLinkCommunicationsForContact: jest.fn(() =>
    Promise.resolve({ emailsLinked: 0, messagesLinked: 0, alreadyLinked: 0 }),
  ),
}));

jest.mock("../services/emailSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/transactionSyncTrigger", () => ({
  __esModule: true,
  triggerTransactionSyncInBackground: jest.fn(),
  isAutoSyncInFlight: jest.fn(() => false),
}));
jest.mock("../services/messagesSyncTrigger", () => ({
  __esModule: true,
  triggerMessagesSyncInBackground: jest.fn(),
  isMessagesSyncInFlight: jest.fn(() => false),
}));
jest.mock("../services/auditCoverageService", () => ({
  __esModule: true,
  computeAuditCoverage: jest.fn(),
  getAuditCoverage: jest.fn(),
}));
jest.mock("../services/gmailFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/outlookFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/transactionExtractorService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/contactsService", () => ({
  __esModule: true,
  getContactNames: jest.fn(() => Promise.resolve({ contacts: [] })),
}));
jest.mock("../services/messageMatchingService", () => ({
  __esModule: true,
  createCommunicationReference: jest.fn(),
}));
jest.mock("../services/macOSMessagesImportService", () => ({ __esModule: true, default: {} }));

import { registerTransactionCrudHandlers } from "../handlers/transactionCrudHandlers";
import { LAST_CLIENT_REMOVED_ERROR } from "../utils/transactionClientRule";

const mockEvent = {} as IpcMainInvokeEvent;
const TX = "11111111-1111-4111-8111-111111111111";
const DANA = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";

/** Drive the IPC channel exactly as the preload bridge does. */
async function batchUpdate(
  operations: Array<Record<string, unknown>>,
): Promise<{ refused: boolean; error: string | null }> {
  try {
    const result = await registeredHandlers.get("transactions:batchUpdateContacts")(
      mockEvent,
      TX,
      operations,
    );
    return { refused: result?.success !== true, error: result?.error ?? null };
  } catch (e) {
    return { refused: true, error: e instanceof Error ? e.message : String(e) };
  }
}

beforeEach(() => {
  registeredHandlers.clear();
  batchWrite.mockClear();
  currentRows = [];
  registerTransactionCrudHandlers(null);
});

describe("transactions:batchUpdateContacts refuses to strip the last Client (BACKLOG-2681)", () => {
  /**
   * THE REPORTED DEFECT, DRIVEN THROUGH IPC. Before this change the handler
   * validated `action` and `contactId` and nothing else, so this save
   * succeeded and left the deal with no Client at all.
   */
  it("refuses changing the only Client's role away", async () => {
    currentRows = [
      { contact_id: DANA, role: "client" },
      { contact_id: AGENT, role: "seller_agent" },
    ];

    const outcome = await batchUpdate([
      { action: "add", contactId: DANA, role: "buyer_agent", specificRole: "buyer_agent" },
    ]);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toBe(LAST_CLIENT_REMOVED_ERROR);
  });

  /**
   * THE LEG THAT CATCHES A CHECK PLACED AFTER THE WRITE. A rule that threw once
   * the rows were already changed would satisfy the assertion above and still
   * have left the deal broken.
   */
  it("does not reach the database when it refuses", async () => {
    currentRows = [{ contact_id: DANA, role: "client" }];

    await batchUpdate([{ action: "remove", contactId: DANA }]);

    expect(batchWrite).not.toHaveBeenCalled();
  });

  it("refuses removing the only Client outright", async () => {
    currentRows = [
      { contact_id: DANA, role: "client" },
      { contact_id: AGENT, role: "seller_agent" },
    ];

    const outcome = await batchUpdate([{ action: "remove", contactId: DANA }]);

    expect(outcome.refused).toBe(true);
    expect(outcome.error).toBe(LAST_CLIENT_REMOVED_ERROR);
  });
});

describe("the saves that must still go through", () => {
  it("allows moving the Client role to a different person", async () => {
    currentRows = [
      { contact_id: DANA, role: "client" },
      { contact_id: AGENT, role: "seller_agent" },
    ];

    const outcome = await batchUpdate([
      { action: "add", contactId: DANA, role: "buyer_agent", specificRole: "buyer_agent" },
      { action: "add", contactId: AGENT, role: "client", specificRole: "client" },
    ]);

    expect(outcome.refused).toBe(false);
    expect(batchWrite).toHaveBeenCalledTimes(1);
  });

  /**
   * `EditContactsModal` emits a remove-then-add pair for an UNCHANGED row
   * whenever some other contact changed. This is the ordinary save, and a
   * set-difference implementation of the rule would refuse it.
   */
  it("allows the remove-then-add pair the modal emits for an unchanged Client", async () => {
    currentRows = [{ contact_id: DANA, role: "client" }];

    const outcome = await batchUpdate([
      { action: "remove", contactId: DANA, role: "client" },
      { action: "add", contactId: DANA, role: "client", specificRole: "client" },
    ]);

    expect(outcome.refused).toBe(false);
    expect(batchWrite).toHaveBeenCalledTimes(1);
  });

  /**
   * THE NON-REGRESSION LEG. A deal that already has no Client stays editable —
   * the reason the rule is "must not REMOVE the last Client" rather than
   * "must always have one". This goes red if anyone tightens it later.
   */
  it("allows any edit to a deal that already had no Client", async () => {
    currentRows = [{ contact_id: AGENT, role: "seller_agent" }];

    const outcome = await batchUpdate([{ action: "remove", contactId: AGENT }]);

    expect(outcome.refused).toBe(false);
    expect(batchWrite).toHaveBeenCalledTimes(1);
  });

  it("allows adding a second Client", async () => {
    currentRows = [{ contact_id: DANA, role: "client" }];

    const outcome = await batchUpdate([
      { action: "add", contactId: AGENT, role: "client", specificRole: "client" },
    ]);

    expect(outcome.refused).toBe(false);
    expect(batchWrite).toHaveBeenCalledTimes(1);
  });
});
