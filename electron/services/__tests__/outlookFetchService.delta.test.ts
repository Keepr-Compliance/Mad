/**
 * BACKLOG-1831: unit tests for the additive-only SHADOW-mode delta fetch.
 *
 * Covers:
 *  - @odata.nextLink paging within a round → @odata.deltaLink capture (new cursor)
 *  - @removed entries skipped and counted (additive-only), never parsed/stored
 *  - HTTP 410 Gone → DeltaTokenExpiredError reset signal
 *  - resume from a stored deltaLink (root stripped like the other paginators)
 *
 * Mocks axios (like outlookFetchService.pagination.test.ts) so the real
 * _graphRequest / _parseMessage run end-to-end.
 */

import outlookFetchService, { DeltaTokenExpiredError } from "../outlookFetchService";
import databaseService from "../databaseService";
import axios from "axios";

jest.mock("../databaseService");
jest.mock("../microsoftAuthService");
jest.mock("axios");
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>;
const mockAxios = axios as jest.MockedFunction<typeof axios>;

const mockUserId = "test-user-id";
const mockTokenRecord = {
  id: "token-id",
  user_id: mockUserId,
  provider: "microsoft" as const,
  purpose: "mailbox" as const,
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  token_expires_at: new Date(Date.now() + 3600000).toISOString(),
  connected_email_address: "me@outlook.com",
  mailbox_connected: true,
  token_refresh_failed_count: 0,
  is_active: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function graphMsg(id: string) {
  return {
    id,
    conversationId: `conv-${id}`,
    subject: `Subject ${id}`,
    from: { emailAddress: { address: "sender@example.com", name: "Sender" } },
    toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
    ccRecipients: [],
    bccRecipients: [],
    receivedDateTime: "2026-02-15T10:00:00Z",
    sentDateTime: "2026-02-15T09:59:00Z",
    hasAttachments: false,
    body: { content: "body", contentType: "text" },
    bodyPreview: "preview",
  };
}

const FOLDER = "folder-1";
const DELTA_LINK = "https://graph.microsoft.com/v1.0/me/mailFolders/folder-1/messages/delta?$deltatoken=FINAL";

describe("outlookFetchService.fetchDeltaEmails (BACKLOG-1831)", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
    await outlookFetchService.initialize(mockUserId);
  });

  it("follows @odata.nextLink across pages and returns the final @odata.deltaLink", async () => {
    mockAxios.mockImplementation((config: unknown) => {
      const cfg = config as { url: string };
      if (cfg.url.includes("$skiptoken=d2")) {
        return Promise.resolve({
          data: { value: [graphMsg("m-2")], "@odata.deltaLink": DELTA_LINK },
        }) as never;
      }
      // first delta page → carries a nextLink to page 2
      return Promise.resolve({
        data: {
          value: [graphMsg("m-0"), graphMsg("m-1")],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/folder-1/messages/delta?$skiptoken=d2",
        },
      }) as never;
    });

    const { emails, deltaLink, removedSkipped } = await outlookFetchService.fetchDeltaEmails(FOLDER, null);

    expect(emails).toHaveLength(3); // 2 from page 1 + 1 from page 2
    expect(emails.map((e) => e.id)).toEqual(["m-0", "m-1", "m-2"]);
    expect(deltaLink).toBe(DELTA_LINK);
    expect(removedSkipped).toBe(0);

    // First call hit the folder delta endpoint with $select.
    const firstUrl = (mockAxios.mock.calls[0][0] as { url: string }).url;
    expect(firstUrl).toContain("/me/mailFolders/folder-1/messages/delta");
    expect(firstUrl).toContain("$select=");
  });

  it("skips and counts @removed entries (additive-only), never parsing them", async () => {
    mockAxios.mockResolvedValue({
      data: {
        value: [
          graphMsg("keep-0"),
          { id: "gone-1", "@removed": { reason: "deleted" } },
          graphMsg("keep-1"),
        ],
        "@odata.deltaLink": DELTA_LINK,
      },
    } as never);

    const { emails, deltaLink, removedSkipped } = await outlookFetchService.fetchDeltaEmails(FOLDER, null);

    expect(emails.map((e) => e.id)).toEqual(["keep-0", "keep-1"]);
    expect(removedSkipped).toBe(1);
    expect(deltaLink).toBe(DELTA_LINK);
  });

  it("throws DeltaTokenExpiredError on HTTP 410 Gone (reset signal)", async () => {
    mockAxios.mockRejectedValue({ response: { status: 410 } } as never);

    await expect(outlookFetchService.fetchDeltaEmails(FOLDER, "stored-delta-link")).rejects.toBeInstanceOf(
      DeltaTokenExpiredError,
    );
  });

  it("resumes from a stored deltaLink (Graph root stripped, no $select re-appended)", async () => {
    mockAxios.mockResolvedValue({
      data: { value: [graphMsg("r-0")], "@odata.deltaLink": DELTA_LINK },
    } as never);

    const stored = "https://graph.microsoft.com/v1.0/me/mailFolders/folder-1/messages/delta?$deltatoken=PREV";
    const { emails, deltaLink } = await outlookFetchService.fetchDeltaEmails(FOLDER, stored);

    expect(emails).toHaveLength(1);
    expect(deltaLink).toBe(DELTA_LINK);
    const url = (mockAxios.mock.calls[0][0] as { url: string }).url;
    expect(url).toBe(stored); // exact resume URL, no $select appended
  });
});
