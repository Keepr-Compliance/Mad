/**
 * BACKLOG-3910 (slice b fix-up, founder ruling 2026-10-11): a locked deal is
 * read-only for the user edits below, refused in the MAIN-PROCESS handler.
 *
 *   C-a  adding a contact (assign-contact, batchUpdateContacts with an add,
 *        restore-contact) is refused on a locked deal.
 *   C-b  attaching emails or texts by hand (link-emails, link-messages, and the
 *        restore-removed-* re-attach paths) is refused on a locked deal.
 *   C-c  the same edits go through on an open deal. Every submission status is
 *        swept, so the boundary (needs_changes / rejected reopen) is covered.
 *
 * The status comes from a mocked `dbGet` only. `refuseIfDealLocked`,
 * `getDealLockReason` and `dealLockReason` all run for real, so a mutation in
 * any of them, or in a handler's call to them, shows up here.
 *
 * The expected locked set is written out as a literal on purpose rather than
 * imported from the mapping: dealLock.parity.test.ts pins the mapping itself.
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
jest.mock("../../services/db/core/dbConnection", () => ({
  dbGet: jest.fn(),
  dbAll: jest.fn(() => []),
  dbRun: jest.fn(),
}));
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: {
    assignContactToTransaction: jest.fn(() => Promise.resolve({})),
    batchUpdateContactAssignments: jest.fn(() => Promise.resolve()),
    linkMessages: jest.fn(() => Promise.resolve()),
    getTransactionDetails: jest.fn(() => Promise.resolve(null)),
  },
  getEarliestCommunicationDate: jest.fn(),
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    restoreContactToTransaction: jest.fn(() => Promise.resolve(false)),
    getTransactionById: jest.fn(() => Promise.resolve(null)),
  },
}));
jest.mock("../../services/auditService", () => ({ __esModule: true, default: { log: jest.fn() } }));
jest.mock("../../services/emailSyncService", () => ({
  __esModule: true,
  default: { fetchAndAutoLinkForContact: jest.fn() },
}));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkCommunicationsForContact: jest.fn(() =>
    Promise.resolve({ emailsLinked: 0, messagesLinked: 0, queuedForReview: 0 }),
  ),
}));
jest.mock("../../services/reviewStateService", () => ({
  countReviewItems: jest.fn(() => 0),
  restoreRejectedToQueue: jest.fn(() => Promise.resolve(0)),
  notifyReviewStateChanged: jest.fn(),
}));
jest.mock("../../services/gmailFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/outlookFetchService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/db/emailDbService", () => ({
  createEmail: jest.fn(), getEmailById: jest.fn(),
  getEmailByExternalId: jest.fn(), getCachedEmails: jest.fn(),
}));
jest.mock("../../services/db/communicationDbService", () => ({
  createCommunication: jest.fn(), removeIgnoredCommunication: jest.fn(),
  confirmEmailLinksByEmailIds: jest.fn(),
}));
jest.mock("../../windowRegistry", () => ({ sendToMainWindow: jest.fn(() => true) }));

import { dbGet } from "../../services/db/core/dbConnection";
import transactionService from "../../services/transactionService";
import databaseService from "../../services/databaseService";
import { registerTransactionCrudHandlers } from "../transactionCrudHandlers";
import { registerEmailLinkingHandlers } from "../emailLinkingHandlers";

const DEAL = "3910b000-0000-4000-8000-000000000001"; // pii-allow-uuid: invented test id
const CONTACT = "3910b000-0000-4000-8000-000000000002"; // pii-allow-uuid: invented test id
const EMAIL = "3910b000-0000-4000-8000-000000000003"; // pii-allow-uuid: invented test id

/** Every value of the schema's submission_status CHECK list. */
const ALL_STATUSES = [
  "not_submitted",
  "submitted",
  "under_review",
  "needs_changes",
  "resubmitted",
  "approved",
  "rejected",
] as const;
/** The founder's ruling, written out: these are read-only. */
const LOCKED = new Set(["submitted", "under_review", "resubmitted", "approved"]);

type Res = { success: boolean; error?: string; dealLocked?: string; refusedEdit?: string };

interface Edit {
  name: string;
  channel: string;
  args: unknown[];
  refusedEdit: string;
  /** The write the handler must NOT reach on a locked deal, and MUST reach on an open one. */
  downstream: () => jest.Mock;
}

const EDITS: Edit[] = [
  {
    name: "add contact (assign-contact)",
    channel: "transactions:assign-contact",
    args: [DEAL, CONTACT, "buyer", "client", false],
    refusedEdit: "add-contact",
    downstream: () => jest.mocked(transactionService.assignContactToTransaction) as unknown as jest.Mock,
  },
  {
    name: "add contact (batchUpdateContacts with an add)",
    channel: "transactions:batchUpdateContacts",
    args: [DEAL, [{ action: "add", contactId: CONTACT, role: "buyer", roleCategory: "client" }]],
    refusedEdit: "add-contact",
    downstream: () => jest.mocked(transactionService.batchUpdateContactAssignments) as unknown as jest.Mock,
  },
  {
    name: "add contact (restore-contact)",
    channel: "transactions:restore-contact",
    args: [DEAL, CONTACT],
    refusedEdit: "add-contact",
    downstream: () => jest.mocked(databaseService.restoreContactToTransaction) as unknown as jest.Mock,
  },
  {
    name: "attach emails (link-emails)",
    channel: "transactions:link-emails",
    args: [[EMAIL], DEAL],
    refusedEdit: "attach-emails",
    downstream: () => jest.mocked(transactionService.getTransactionDetails) as unknown as jest.Mock,
  },
  {
    name: "attach texts (link-messages)",
    channel: "transactions:link-messages",
    args: [["msg-1"], DEAL],
    refusedEdit: "attach-texts",
    downstream: () => jest.mocked(transactionService.linkMessages) as unknown as jest.Mock,
  },
  {
    name: "re-attach a removed email (restore-removed-email)",
    channel: "transactions:restore-removed-email",
    args: ["ignored-1", EMAIL, DEAL],
    refusedEdit: "attach-emails",
    downstream: () => jest.mocked(transactionService.getTransactionDetails) as unknown as jest.Mock,
  },
];

beforeAll(() => {
  registerTransactionCrudHandlers(null);
  registerEmailLinkingHandlers();
});

beforeEach(() => {
  jest.clearAllMocks();
});

function setStatus(status: string | null): void {
  jest.mocked(dbGet).mockReturnValue(status === null ? undefined : { submission_status: status });
}

async function invoke(edit: Edit): Promise<Res> {
  const fn = handlers.get(edit.channel);
  if (!fn) throw new Error(`handler not registered: ${edit.channel}`);
  return (await fn({} as unknown, ...edit.args)) as Res;
}

describe("BACKLOG-3910: a locked deal refuses user edits in the main process", () => {
  it("the sweep covers all seven schema statuses, four of them locked", () => {
    expect(ALL_STATUSES).toHaveLength(7);
    expect(ALL_STATUSES.filter((s) => LOCKED.has(s))).toEqual([
      "submitted",
      "under_review",
      "resubmitted",
      "approved",
    ]);
  });

  for (const edit of EDITS) {
    describe(edit.name, () => {
      for (const status of ALL_STATUSES) {
        if (LOCKED.has(status)) {
          it(`${status}: refused, nothing written`, async () => {
            setStatus(status);
            const res = await invoke(edit);
            expect(res.success).toBe(false);
            expect(res.dealLocked).toBe(status === "approved" ? "sealed" : "submitted");
            expect(res.refusedEdit).toBe(edit.refusedEdit);
            expect(res.error).toMatch(/can't be changed/);
            expect(edit.downstream()).not.toHaveBeenCalled();
          });
        } else {
          it(`${status}: goes through`, async () => {
            setStatus(status);
            const res = await invoke(edit);
            expect(res.dealLocked).toBeUndefined();
            expect(edit.downstream()).toHaveBeenCalled();
          });
        }
      }
    });
  }

  it("a remove-only batch on a locked deal is not an add, so it still runs", async () => {
    setStatus("submitted");
    const fn = handlers.get("transactions:batchUpdateContacts")!;
    const res = (await fn({} as unknown, DEAL, [{ action: "remove", contactId: CONTACT }])) as Res;
    expect(res.dealLocked).toBeUndefined();
    expect(transactionService.batchUpdateContactAssignments).toHaveBeenCalled();
  });

  it("restore-removed-message on a locked deal is refused before anything is read", async () => {
    setStatus("approved");
    const fn = handlers.get("transactions:restore-removed-message")!;
    const res = (await fn({} as unknown, "ignored-1", ["msg-1"], DEAL)) as Res;
    expect(res).toMatchObject({ success: false, dealLocked: "sealed", refusedEdit: "attach-texts" });
    expect(transactionService.linkMessages).not.toHaveBeenCalled();
  });

  it("a deal with no row (NULL status) is open", async () => {
    setStatus(null);
    const res = await invoke(EDITS[0]);
    expect(res.dealLocked).toBeUndefined();
    expect(transactionService.assignContactToTransaction).toHaveBeenCalled();
  });
});
