/**
 * @jest-environment node
 *
 * BACKLOG-3910 (slice b, SR finding I1): adding or assigning a contact on a
 * locked deal must not SEARCH the mailbox. The per-contact link gate stops the
 * linking but not the fetch; `fetchAndAutoLinkForContact`'s lock return is the
 * only thing that stops the provider search, and before this file nothing
 * reddened when it was removed.
 *
 * The status comes from a mocked `dbGet`; `getDealLockReason` and
 * `dealLockReason` run for real. Every schema status is swept, so the open
 * side proves the provider fetch IS reached (the locked assertion is not
 * vacuous).
 */
jest.mock("../db/core/dbConnection", () => ({
  dbGet: jest.fn(),
  dbAll: jest.fn(() => []),
  dbRun: jest.fn(),
}));
jest.mock("../db/contactDbService", () => ({
  ...jest.requireActual("../db/contactDbService"),
  getEmailsByContactId: jest.fn(() => ["party@example.com"]),
}));
jest.mock("../autoLinkService", () => ({
  ...jest.requireActual("../autoLinkService"),
  autoLinkCommunicationsForContact: jest.fn(() =>
    Promise.resolve({ emailsLinked: 0, messagesLinked: 0, alreadyLinked: 0, errors: 0 }),
  ),
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }));

import { dbGet } from "../db/core/dbConnection";
import { getEmailsByContactId } from "../db/contactDbService";
import { autoLinkCommunicationsForContact } from "../autoLinkService";
import emailSyncService from "../emailSyncService";

const DEAL = "3910b000-0000-4000-8000-000000000011"; // pii-allow-uuid: invented test id
const CONTACT = "3910b000-0000-4000-8000-000000000012"; // pii-allow-uuid: invented test id

const ALL_STATUSES = [
  "not_submitted",
  "submitted",
  "under_review",
  "needs_changes",
  "resubmitted",
  "approved",
  "rejected",
] as const;
const LOCKED = new Set(["submitted", "under_review", "resubmitted", "approved"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- private methods spied on the singleton
const svc = emailSyncService as any;

let outlookSpy: jest.SpyInstance;
let gmailSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(svc, "localCacheCoversAuditPeriod").mockReturnValue(false);
  outlookSpy = jest.spyOn(svc, "fetchOutlookEmails").mockResolvedValue({ fetched: 2, stored: 2 });
  gmailSpy = jest.spyOn(svc, "fetchGmailEmails").mockResolvedValue({ fetched: 1, stored: 1 });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function run() {
  return emailSyncService.fetchAndAutoLinkForContact({
    userId: "user-1",
    transactionId: DEAL,
    contactId: CONTACT,
    transactionDetails: { started_at: "2026-01-01", created_at: "2026-01-01", closed_at: null },
    queueForReviewInsteadOfLinking: true,
  });
}

describe("BACKLOG-3910 I1: no mailbox search for a contact added to a locked deal", () => {
  for (const status of ALL_STATUSES) {
    if (LOCKED.has(status)) {
      it(`${status}: the provider is never searched and nothing is linked`, async () => {
        jest.mocked(dbGet).mockReturnValue({ submission_status: status });
        const res = await run();
        expect(outlookSpy).not.toHaveBeenCalled();
        expect(gmailSpy).not.toHaveBeenCalled();
        expect(getEmailsByContactId).not.toHaveBeenCalled();
        expect(autoLinkCommunicationsForContact).not.toHaveBeenCalled();
        expect(res.emailsFetched).toBe(0);
        expect(res.emailsStored).toBe(0);
        expect(res.autoLinkResult.skippedLocked).toBe(status === "approved" ? "sealed" : "submitted");
      });
    } else {
      it(`${status}: the provider IS searched`, async () => {
        jest.mocked(dbGet).mockReturnValue({ submission_status: status });
        const res = await run();
        expect(outlookSpy).toHaveBeenCalledTimes(1);
        expect(gmailSpy).toHaveBeenCalledTimes(1);
        expect(res.emailsFetched).toBe(3);
        expect(res.autoLinkResult.skippedLocked).toBeUndefined();
      });
    }
  }
});
