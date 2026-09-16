/**
 * @jest-environment node
 */

/**
 * BACKLOG-3364 — bulk Submit must not aim at a personal organization.
 *
 * `submissionService` does NOT go through the shared membership helper: it keeps
 * its own query, deliberately, because the helper filters on
 * `license_status = 'active'` and the database's submission rules do not — a
 * suspended brokerage member can submit today and this item does not take that
 * away (SR delta pm_comments 3e27deee ruling 4).
 *
 * So the same three properties have to be proved again here, against this
 * query:
 *
 *   1. a personal organization is refused, and refused BEFORE any attachment
 *      is uploaded — otherwise a solo user waits out the longest stage of the
 *      submission and then meets a database refusal, with files already pushed
 *      to storage under a submission id that will never exist;
 *   2. a brokerage member with a personal row as well can still submit;
 *   3. no argument names the new column, so the query works on both sides of
 *      the migration.
 */

import {
  createPostgrestEmulator,
  brokerageMembership,
  personalMembership,
  PERSONAL_COLUMN,
  FIXTURE_USER_ID,
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  type Emulator,
} from "./helpers/postgrestEmulator";

let emulator: Emulator;

const mockGetAuthSession = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      from: (table: string) => emulator.from(table),
      rpc: (fn: string, args?: unknown) => emulator.rpc(fn, args),
    }),
    getAuthSession: (...args: unknown[]) => mockGetAuthSession(...args),
  },
}));

const mockUploadAttachments = jest.fn();
jest.mock("../supabaseStorageService", () => ({
  __esModule: true,
  default: {
    uploadAttachments: (...args: unknown[]) => mockUploadAttachments(...args),
    deleteSubmissionAttachments: jest.fn(),
  },
}));

jest.mock("../databaseService");
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../contactsService");
jest.mock("../emailAttachmentService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../contactResolutionService", () => ({
  resolveHandles: jest.fn().mockResolvedValue({ names: {}, matches: {} }),
  extractParticipantHandles: jest.fn().mockReturnValue([]),
  nameForHandle: jest.fn(),
}));
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.0.0") },
  net: { isOnline: jest.fn().mockReturnValue(true) },
}));

import { submissionService } from "../submissionService";
import databaseService from "../databaseService";

/** `getUserOrganizationId` is private; the query it issues is the subject. */
const getUserOrganizationId = (): Promise<string | null> =>
  (submissionService as unknown as {
    getUserOrganizationId(): Promise<string | null>;
  }).getUserOrganizationId();

describe("BACKLOG-3364 — which organization a submission is aimed at", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emulator = createPostgrestEmulator();
    mockGetAuthSession.mockResolvedValue({ userId: FIXTURE_USER_ID });
  });

  it("refuses a personal-only user — there is no brokerage to submit to", async () => {
    emulator.set({ rows: { organization_members: [personalMembership()] } });

    await expect(getUserOrganizationId()).resolves.toBeNull();
  });

  it("never hands back the personal organization's id", async () => {
    emulator.set({ rows: { organization_members: [personalMembership()] } });

    await expect(getUserOrganizationId()).resolves.not.toBe(FIXTURE_PERSONAL_ORG_ID);
  });

  it("picks the brokerage when the user holds both rows, personal first", async () => {
    emulator.set({
      rows: {
        organization_members: [
          personalMembership({ createdAt: "2026-01-01T00:00:00.000Z" }),
          brokerageMembership({ createdAt: "2026-02-01T00:00:00.000Z" }),
        ],
      },
    });

    await expect(getUserOrganizationId()).resolves.toBe(FIXTURE_BROKERAGE_ORG_ID);
  });

  it("does not filter by licence status — a suspended brokerage member can still submit", async () => {
    // The database's submission rules have no status filter, so neither does
    // this query. Adding `.eq("license_status", "active")` here would take away
    // something that works today.
    emulator.set({
      rows: {
        organization_members: [brokerageMembership({ licenseStatus: "suspended" })],
      },
    });

    await expect(getUserOrganizationId()).resolves.toBe(FIXTURE_BROKERAGE_ORG_ID);
  });

  it("resolves a brokerage member against a database WITHOUT the column", async () => {
    emulator.set({
      columnPresent: false,
      rows: { organization_members: [brokerageMembership({ phase: "pre" })] },
    });

    await expect(getUserOrganizationId()).resolves.toBe(FIXTURE_BROKERAGE_ORG_ID);
  });

  it("names the personal column in no select, order or filter", async () => {
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });

    await getUserOrganizationId();

    expect(emulator.state.selects).toEqual([
      { table: "organization_members", columns: "organization_id, organizations(*)" },
    ]);
    for (const order of emulator.state.orders) {
      expect(order.column).not.toContain(PERSONAL_COLUMN);
    }
  });

  it("orders by two base columns of organization_members, ascending", async () => {
    // Deleting either `.order()`, dropping the tie-break, swapping the
    // direction, or moving the sort onto the embed each change this value.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });

    await getUserOrganizationId();

    expect(emulator.state.orders).toEqual([
      { table: "organization_members", column: "created_at", options: { ascending: true } },
      { table: "organization_members", column: "id", options: { ascending: true } },
    ]);
  });

  it("answers null, not an arbitrary organization, when the query errors", async () => {
    emulator.set({ columnPresent: false, rows: { organization_members: [] } });
    // Force the error shape a pre-migration database gives a column-naming
    // query, without changing the code: the assertion is that an error is not
    // silently turned into an organization.
    const original = emulator.from;
    emulator.from = (table: string) => original(table).select(PERSONAL_COLUMN);

    await expect(getUserOrganizationId()).resolves.toBeNull();
  });
});

describe("BACKLOG-3364 — a solo user's Submit is refused before anything is uploaded", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emulator = createPostgrestEmulator();
    mockGetAuthSession.mockResolvedValue({ userId: FIXTURE_USER_ID });

    (databaseService.getTransactionById as jest.Mock).mockResolvedValue({
      id: "txn-3364",
      title: "Fixture deal",
      started_at: null,
      closed_at: null,
    });
    (databaseService.getTransactionMessages as jest.Mock).mockReturnValue([]);
    (databaseService.getTransactionEmails as jest.Mock).mockReturnValue([]);
    (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([]);
  });

  it("reports the no-organization refusal and uploads nothing", async () => {
    emulator.set({ rows: { organization_members: [personalMembership()] } });

    const result = await submissionService.submitTransaction("txn-3364");

    expect(result).toMatchObject({
      success: false,
      submissionId: null,
      error: expect.stringMatching(/not a member of any organization/i),
    });
    // The point of refusing at the lookup rather than at the insert: the
    // longest stage of a submission never starts.
    expect(mockUploadAttachments).not.toHaveBeenCalled();
    // No submission was created in the cloud database either — an INSERT into
    // transaction_submissions aimed at the personal organization is exactly
    // what must not happen. Scoped to the three submission tables on purpose:
    // the failure path also DELETEs against the submission id this attempt
    // generated and never used (cleanupFailedSubmission — it matches no row),
    // and records the refusal in error_logs, both of which are today's
    // behaviour for any failed submit and neither of which is a submission.
    const submissionWrites = emulator.state.writes.filter(
      (w) =>
        ["transaction_submissions", "submission_messages", "submission_attachments"].includes(
          w.table
        ) && w.op !== "delete"
    );
    expect(submissionWrites).toEqual([]);
  });

  it("gets past the organization lookup for a brokerage member", async () => {
    // The counterpart, so the refusal above is shown to be about the personal
    // organization and not about the fixture failing somewhere earlier: with a
    // brokerage row the same call reaches the existing-submission check, which
    // is the FIRST thing after the lookup.
    emulator.set({ rows: { organization_members: [brokerageMembership()] } });

    const result = await submissionService.submitTransaction("txn-3364");

    expect(result.error ?? "").not.toMatch(/not a member of any organization/i);
  });
});
