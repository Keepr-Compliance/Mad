/**
 * BACKLOG-3837 follow-up — `transactions:get-message-contacts` carries the pending state
 * of the message-derived names, and tells the window when they land.
 *
 * The service answer (`{ contacts, messageDerivedPending }`) is the shape
 * transactionService.getMessageContactsWithStatus returns; the real-worker behaviour
 * behind it is pinned in electron/services/__tests__/attachMessagesNeverOnMain-3837.test.ts.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: { getMessageContactsWithStatus: jest.fn() },
}));
jest.mock("../../services/gmailFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/outlookFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/emailSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/db/emailDbService", () => ({
  createEmail: jest.fn(), getEmailById: jest.fn(),
  getEmailByExternalId: jest.fn(), getCachedEmails: jest.fn(),
}));
jest.mock("../../services/db/communicationDbService", () => ({
  createCommunication: jest.fn(), removeIgnoredCommunication: jest.fn(),
  confirmEmailLinksByEmailIds: jest.fn(),
}));
jest.mock("../../services/db/messageDerivedContactsCache", () => ({
  joinMessageDerivedRead: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../services/db/messageRosterCache", () => ({
  joinMessageRosterRead: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../windowRegistry", () => ({ sendToMainWindow: jest.fn(() => true) }));

import transactionService from "../../services/transactionService";
import { sendToMainWindow } from "../../windowRegistry";
import { registerEmailLinkingHandlers } from "../emailLinkingHandlers";

const USER = "11111111-1111-4111-8111-111111111111"; // pii-allow-uuid: invented, not from any live row
const ROSTER = [
  { contact: "+12005550100", contactName: "Saved Person 0", messageCount: 2, lastMessageAt: "2026-01-01T10:00:00.000Z", threadNames: [] },
  { contact: "Avery Example", contactName: null, messageCount: 1, lastMessageAt: "2026-01-01T09:00:00.000Z", threadNames: [] },
];

beforeAll(() => {
  registerEmailLinkingHandlers();
});

beforeEach(() => {
  jest.clearAllMocks();
});

const call = (userId: string) =>
  handlers.get("transactions:get-message-contacts")!({} as unknown, userId) as Promise<{
    success: boolean;
    contacts?: unknown[];
    contactsStatus?: { messageDerivedPending?: boolean };
  }>;

describe("BACKLOG-3837: get-message-contacts pending state", () => {
  it("pending: the full roster, flagged pending; the window is told when the names land", async () => {
    jest.mocked(transactionService.getMessageContactsWithStatus).mockResolvedValue({
      contacts: ROSTER,
      messageDerivedPending: true,
      rosterPending: false,
    });
    const r = await call(USER);
    expect(r.success).toBe(true);
    expect(r.contacts).toEqual(ROSTER);
    expect(r.contactsStatus).toEqual({ messageDerivedPending: true });
    await new Promise((res) => setTimeout(res, 0));
    expect(jest.mocked(sendToMainWindow)).toHaveBeenCalledWith("contacts:message-derived-ready", { userId: USER });
  });

  it("roster pending: an EMPTY answer flagged rosterPending (never a bare empty roster); the window is told when it lands", async () => {
    jest.mocked(transactionService.getMessageContactsWithStatus).mockResolvedValue({
      contacts: [],
      messageDerivedPending: false,
      rosterPending: true,
    });
    const r = await call(USER);
    expect(r.success).toBe(true);
    expect(r.contacts).toEqual([]);
    expect(r.contactsStatus).toEqual({ rosterPending: true });
    await new Promise((res) => setTimeout(res, 0));
    expect(jest.mocked(sendToMainWindow)).toHaveBeenCalledWith("contacts:message-derived-ready", { userId: USER });
  });

  it("not pending: no contactsStatus, nothing sent", async () => {
    jest.mocked(transactionService.getMessageContactsWithStatus).mockResolvedValue({
      contacts: ROSTER,
      messageDerivedPending: false,
      rosterPending: false,
    });
    const r = await call(USER);
    expect("contactsStatus" in r).toBe(false);
    await new Promise((res) => setTimeout(res, 0));
    expect(jest.mocked(sendToMainWindow)).not.toHaveBeenCalled();
  });
});
