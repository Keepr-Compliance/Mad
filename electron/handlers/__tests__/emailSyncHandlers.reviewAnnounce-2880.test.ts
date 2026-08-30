/**
 * BACKLOG-2880 — the Sync button must ANNOUNCE what it queued.
 *
 * Founder ruling, 2026-08-26:
 *   "maybe say 'sync completed'. the needs review popup anyway shows up on
 *    adding contact or changing range which triggers a sync"
 *
 * The toast goes neutral and the Needs Review popup carries the count. But his
 * premise did not hold on THIS path: the popup is gated on
 * `reviewQueue.lastFound > 0` (TransactionDetails.tsx:1456), and `lastFound` is
 * only ever set from a `review:queue-changed` broadcast. Add-contact and
 * range-change reach the popup because their sweeps run through
 * `syncReviewQueueForTransaction`, which broadcasts. **The Sync button never
 * broadcast at all**, so with 9 queued and 0 linked the popup stayed silent —
 * and with a neutral toast the user would have been told nothing whatsoever.
 *
 * So the fix is at the EMITTING end, not in the renderer: the sync handler now
 * announces its run on the SAME channel every other trigger uses. The renderer
 * side of that chain is already pinned by `reviewLiveRefresh-2791` (a broadcast
 * with added/linked drives lastAdded/lastLinked/lastFound, and `lastFound` is
 * what the popup gate reads). This suite pins the half that did not exist.
 *
 * NOT a second announcement — deliberately. A parallel notification is how two
 * surfaces start disagreeing about one number.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  },
}));

jest.mock("../../utils/wrapHandler", () => ({ wrapHandler: (fn: IpcHandler) => fn }));

const mockSyncTransactionEmails = jest.fn();
jest.mock("../../services/emailSyncService", () => ({
  __esModule: true,
  default: {
    precacheEmails: jest.fn(),
    syncTransactionEmails: (...a: unknown[]) => mockSyncTransactionEmails(...a),
  },
  EMAIL_FETCH_SAFETY_CAP: 0,
  SENT_ITEMS_SAFETY_CAP: 0,
}));

const mockNotifyDiscovery = jest.fn();
jest.mock("../../services/reviewStateService", () => ({
  __esModule: true,
  notifyReviewDiscovery: (...a: unknown[]) => mockNotifyDiscovery(...a),
}));

const mockGetTransactionWithContacts = jest.fn();
jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: {
    getTransactionWithContacts: (...a: unknown[]) => mockGetTransactionWithContacts(...a),
    scanAndExtractTransactions: jest.fn(),
    cancelScan: jest.fn(),
  },
}));

jest.mock("../../services/db/contactDbService", () => ({
  getEmailsByContactId: jest.fn(() => ["jane@example.com"]),
}));
jest.mock("../../utils/rateLimit", () => ({
  rateLimiters: {
    scan: { canExecute: jest.fn().mockReturnValue({ allowed: true }) },
    sync: { canExecute: jest.fn().mockReturnValue({ allowed: true }) },
    precache: { canExecute: jest.fn().mockReturnValue({ allowed: true }) },
  },
}));
jest.mock("../../services/featureGateService", () => ({
  __esModule: true,
  default: { checkFeature: jest.fn() },
}));
jest.mock("../../services/llm/llmConfigService", () => ({
  __esModule: true,
  default: { getUserConfig: jest.fn() },
}));
jest.mock("../featureGateHandlers", () => ({
  __esModule: true,
  resolveOrgId: jest.fn(),
  registerFeatureGateHandlers: jest.fn(),
}));
jest.mock("../../services/transactionSyncTrigger", () => ({
  triggerBatchTransactionSyncInBackground: jest.fn(),
}));
jest.mock("../../utils/emailDateRange", () => ({ computeEmailFetchSinceDate: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock("../../utils/validation", () => ({
  ValidationError: class ValidationError extends Error {},
  validateUserId: (id: string) => id,
  validateTransactionId: (id: string) => id,
  sanitizeObject: (o: unknown) => o,
}));

import { registerEmailSyncHandlers } from "../emailSyncHandlers";

const TXN = "t-2880";

describe("BACKLOG-2880 — the Sync button announces its run on the review channel", () => {
  let sync: IpcHandler;

  beforeAll(() => {
    registerEmailSyncHandlers({} as never);
    sync = handlers.get("transactions:sync-and-fetch-emails")!;
    expect(sync).toBeDefined();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTransactionWithContacts.mockResolvedValue({
      id: TXN,
      user_id: "u-2880",
      contact_assignments: [{ contact_id: "c-2880" }],
    });
  });

  it("THE FOUNDER'S CASE — 9 queued, 0 linked: the run is announced with its counts", async () => {
    // The exact shape of pass C: mailbox already cached (0 stored), nine
    // address-unmatched emails queued for review, nothing linked. Before this
    // fix the handler returned and said nothing, so the popup gate never saw a
    // non-zero lastFound and the founder got silence.
    mockSyncTransactionEmails.mockResolvedValue({
      success: true,
      emailsFetched: 63,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalQueuedForReview: 9,
    });

    await sync({}, TXN);

    expect(mockNotifyDiscovery).toHaveBeenCalledTimes(1);
    const [transactionId, payload] = mockNotifyDiscovery.mock.calls[0];
    expect(transactionId).toBe(TXN);
    // `added` is the popup's R and `linked` its L. The hook takes both from the
    // EVENT rather than re-deriving them, because only the run that produced
    // them knows what it did.
    expect(payload).toMatchObject({ added: 9, linked: 0 });
  });

  it("passes the SYNC BUTTON's queue flag, so there is something to announce", async () => {
    // The announcement is only meaningful because the button QUEUES rather than
    // links. Asserted on the actual call, not on the mock's existence.
    mockSyncTransactionEmails.mockResolvedValue({ success: true, totalQueuedForReview: 0 });

    await sync({}, TXN);

    expect(mockSyncTransactionEmails.mock.calls[0][0]).toMatchObject({
      transactionId: TXN,
      ingestSourceOverride: "manual",
      queueForReviewInsteadOfLinking: true,
    });
  });

  it("a run that LINKED reports its linked count, so a link-only run is not silent", async () => {
    // N = L + R. A sweep that linked six and queued none still found something.
    mockSyncTransactionEmails.mockResolvedValue({
      success: true,
      emailsFetched: 6,
      emailsStored: 6,
      totalEmailsLinked: 6,
      totalMessagesLinked: 0,
      totalQueuedForReview: 0,
    });

    await sync({}, TXN);

    expect(mockNotifyDiscovery.mock.calls[0][1]).toMatchObject({ added: 0, linked: 6 });
  });

  it("announces even when it found NOTHING, so the badge and tabs still re-read", async () => {
    // "Refresh regardless" and "announce only when there is something" are
    // different rules and both belong to the existing contract: the hook always
    // re-reads on the event, and gates the POPUP on added/linked being non-zero.
    // Emitting unconditionally is what makes a Sync click refresh the queue at
    // all — which it never did before.
    mockSyncTransactionEmails.mockResolvedValue({
      success: true,
      emailsFetched: 0,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalQueuedForReview: 0,
    });

    await sync({}, TXN);

    expect(mockNotifyDiscovery).toHaveBeenCalledTimes(1);
    expect(mockNotifyDiscovery.mock.calls[0][1]).toMatchObject({ added: 0, linked: 0 });
  });

  it("does NOT announce when the sync failed — a failure discovered nothing", async () => {
    mockSyncTransactionEmails.mockResolvedValue({
      success: false,
      error: "Network disconnected",
    });

    await sync({}, TXN);

    expect(mockNotifyDiscovery).not.toHaveBeenCalled();
  });

  it("returns the sync result unchanged — announcing must not alter the response", async () => {
    // The toast reads this object. An announcement that rewrote it would make
    // the two surfaces disagree, which is the failure this design avoids.
    const result = {
      success: true,
      emailsFetched: 63,
      emailsStored: 0,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalQueuedForReview: 9,
    };
    mockSyncTransactionEmails.mockResolvedValue(result);

    await expect(sync({}, TXN)).resolves.toEqual(result);
  });
});
