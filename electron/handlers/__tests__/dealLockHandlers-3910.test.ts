/**
 * BACKLOG-3910 (slice b fix-up, founder ruling 2026-10-11): a locked deal is
 * read-only for the user edits below, refused in the MAIN-PROCESS handler.
 *
 *   C-a  adding a contact (assign-contact, batchUpdateContacts with an add,
 *        restore-contact) is refused on a locked deal.
 *   C-b  attaching emails or texts by hand (link-emails, link-messages, and the
 *        restore-removed-* re-attach paths) is refused on a locked deal.
 *   C-d  removing contacts, emails or texts (remove-contact, a remove-only
 *        batch, unlink-communication, unlink-messages, unlink-text-threads) is
 *        refused on a locked deal.
 *   C-e  approving or rejecting a Needs Review item (review:approve,
 *        review:reject) is refused on a locked deal.
 *   C-f  (slice d, founder 2026-10-12) editing the deal's details through
 *        transactions:update, audit dates included, is refused on a locked deal.
 *        Checklists: checklistDealLock-3910d.test.ts.
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
    removeContactFromTransaction: jest.fn(() => Promise.resolve()),
    unlinkCommunication: jest.fn(() => Promise.resolve({ unlinkedIds: [] })),
    unlinkMessages: jest.fn(() => Promise.resolve()),
    linkMessages: jest.fn(() => Promise.resolve()),
    getTransactionDetails: jest.fn(() => Promise.resolve(null)),
    updateTransaction: jest.fn(() => Promise.resolve()),
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
jest.mock("../../services/transactionTextThreadsService", () => ({
  unlinkTextThreads: jest.fn(() => Promise.resolve({ removed: 0, messageIds: [] })),
}));
jest.mock("../../services/reviewStateService", () => ({
  approveReviewItems: jest.fn(() => Promise.resolve({ approved: 1 })),
  rejectReviewItems: jest.fn(() => Promise.resolve({ rejected: 1 })),
  getReviewItemTransactionIds: jest.fn(() => ["3910b000-0000-4000-8000-000000000001"]), // pii-allow-uuid: invented test id
  getReviewState: jest.fn(),
  syncReviewQueueForTransaction: jest.fn(),
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
jest.mock("./../featureGateHandlers", () => ({ isHideFromExportAllowed: jest.fn(() => Promise.resolve(true)) }));
jest.mock("../../windowRegistry", () => ({ sendToMainWindow: jest.fn(() => true) }));

import { dbGet } from "../../services/db/core/dbConnection";
import transactionService from "../../services/transactionService";
import databaseService from "../../services/databaseService";
import { registerTransactionCrudHandlers } from "../transactionCrudHandlers";
import { registerEmailLinkingHandlers } from "../emailLinkingHandlers";
import { registerHiddenTextHandlers } from "../hiddenTextHandlers";
import { registerReviewQueueHandlers } from "../reviewQueueHandlers";
import { approveReviewItems, rejectReviewItems } from "../../services/reviewStateService";
import { unlinkTextThreads } from "../../services/transactionTextThreadsService";

const DEAL = "3910b000-0000-4000-8000-000000000001"; // pii-allow-uuid: invented test id
const CONTACT = "3910b000-0000-4000-8000-000000000002"; // pii-allow-uuid: invented test id
const COMM = "3910b000-0000-4000-8000-000000000004"; // pii-allow-uuid: invented test id
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
    name: "change the audit start date (transactions:update)",
    channel: "transactions:update",
    args: [DEAL, { started_at: "2026-01-15" }],
    refusedEdit: "edit-deal-details",
    downstream: () => jest.mocked(transactionService.updateTransaction) as unknown as jest.Mock,
  },
  {
    name: "change another deal field (transactions:update, address)",
    channel: "transactions:update",
    args: [DEAL, { property_address: "6 Control Street" }],
    refusedEdit: "edit-deal-details",
    downstream: () => jest.mocked(transactionService.updateTransaction) as unknown as jest.Mock,
  },
  {
    name: "hide a text from export (hide-text-from-export)",
    channel: "transactions:hide-text-from-export",
    args: [DEAL, "msg-1"],
    refusedEdit: "hide-text",
    downstream: () => jest.mocked(databaseService.getTransactionById) as unknown as jest.Mock,
  },
  {
    name: "unhide a text from export (unhide-text-from-export)",
    channel: "transactions:unhide-text-from-export",
    args: [DEAL, "msg-1"],
    refusedEdit: "unhide-text",
    downstream: () => jest.mocked(databaseService.getTransactionById) as unknown as jest.Mock,
  },
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
  {
    name: "remove contact (remove-contact)",
    channel: "transactions:remove-contact",
    args: [DEAL, CONTACT],
    refusedEdit: "remove-contact",
    downstream: () => jest.mocked(transactionService.removeContactFromTransaction) as unknown as jest.Mock,
  },
  {
    name: "remove contact (batchUpdateContacts, remove only)",
    channel: "transactions:batchUpdateContacts",
    args: [DEAL, [{ action: "remove", contactId: CONTACT }]],
    refusedEdit: "remove-contact",
    downstream: () => jest.mocked(transactionService.batchUpdateContactAssignments) as unknown as jest.Mock,
  },
  {
    name: "remove an email (unlink-communication)",
    channel: "transactions:unlink-communication",
    args: [COMM],
    refusedEdit: "remove-emails",
    downstream: () => jest.mocked(transactionService.unlinkCommunication) as unknown as jest.Mock,
  },
  {
    name: "remove texts (unlink-messages, deal passed)",
    channel: "transactions:unlink-messages",
    args: [["msg-1"], DEAL],
    refusedEdit: "remove-texts",
    downstream: () => jest.mocked(transactionService.unlinkMessages) as unknown as jest.Mock,
  },
  {
    name: "remove texts (unlink-messages, deal found from the message)",
    channel: "transactions:unlink-messages",
    args: [["msg-1"]],
    refusedEdit: "remove-texts",
    downstream: () => jest.mocked(transactionService.unlinkMessages) as unknown as jest.Mock,
  },
  {
    name: "remove text threads (unlink-text-threads)",
    channel: "transactions:unlink-text-threads",
    args: [DEAL, ["thread-1"]],
    refusedEdit: "remove-texts",
    downstream: () => jest.mocked(unlinkTextThreads) as unknown as jest.Mock,
  },
  {
    name: "approve a Needs Review item (review:approve)",
    channel: "review:approve",
    args: [["pending:item-1"]],
    refusedEdit: "approve-review",
    downstream: () => jest.mocked(approveReviewItems) as unknown as jest.Mock,
  },
  {
    name: "reject a Needs Review item (review:reject)",
    channel: "review:reject",
    args: [["pending:item-1"]],
    refusedEdit: "reject-review",
    downstream: () => jest.mocked(rejectReviewItems) as unknown as jest.Mock,
  },
];

beforeAll(() => {
  registerTransactionCrudHandlers(null);
  registerEmailLinkingHandlers();
  registerReviewQueueHandlers();
  registerHiddenTextHandlers();
});

beforeEach(() => {
  jest.clearAllMocks();
});

function setStatus(status: string | null): void {
  // The deal-lookup queries (communication -> deal, message -> deal) answer with the deal;
  // the status query answers with the status under test.
  jest.mocked(dbGet).mockImplementation(((query: string) => {
    if (/FROM communications|FROM messages/.test(String(query))) return { transaction_id: DEAL };
    return status === null ? undefined : { submission_status: status };
  }) as never);
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

  it("restore-removed-message on a locked deal is refused before anything is read", async () => {
    setStatus("approved");
    const fn = handlers.get("transactions:restore-removed-message")!;
    const res = (await fn({} as unknown, "ignored-1", ["msg-1"], DEAL)) as Res;
    expect(res).toMatchObject({ success: false, dealLocked: "sealed", refusedEdit: "attach-texts" });
    expect(transactionService.linkMessages).not.toHaveBeenCalled();
  });

  it("a deal with no row (NULL status) is open", async () => {
    setStatus(null);
    const res = await invoke(EDITS.find((e) => e.refusedEdit === "add-contact")!);
    expect(res.dealLocked).toBeUndefined();
    expect(transactionService.assignContactToTransaction).toHaveBeenCalled();
  });
});
