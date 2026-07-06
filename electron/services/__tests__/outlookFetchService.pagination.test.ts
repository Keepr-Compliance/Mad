/**
 * BACKLOG-1802 / BACKLOG-1753: Outlook fetch-completeness unit tests.
 *
 * Covers the root cause of the fresh-install 18/69 slice and its fix:
 *  - @odata.nextLink follow-through for $search (was truncated to one page)
 *  - the MAX_GRAPH_PAGES cap + LOUD truncation telemetry (never silent)
 *  - Prefer: IdType="ImmutableId" on every Graph call
 *  - $batch existence validation (stale KQL hits dropped)
 *  - sent-items search covers BOTH to: and cc: recipients
 */

import outlookFetchService from "../outlookFetchService";
import databaseService from "../databaseService";
import * as Sentry from "@sentry/electron/main";
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
const mockCaptureMessage = Sentry.captureMessage as jest.Mock;

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

/** A $batch response marking every request id in the batch as live (200). */
function batchAllLive(config: { data?: { requests?: Array<{ id: string }> } }) {
  const requests = config.data?.requests ?? [];
  return { data: { responses: requests.map((r) => ({ id: r.id, status: 200 })) } };
}

describe("outlookFetchService fetch-completeness (BACKLOG-1802)", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
    await outlookFetchService.initialize(mockUserId);
  });

  it("sets Prefer: IdType=ImmutableId on every Graph call", async () => {
    mockAxios.mockResolvedValue({ data: { value: [] } });
    await outlookFetchService.searchEmails({ after: new Date("2026-01-01") });
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({ Prefer: 'IdType="ImmutableId"' }),
      }),
    );
  });

  it("$search follows @odata.nextLink across ALL pages (fixes the 1-page truncation)", async () => {
    mockAxios.mockImplementation((config: unknown) => {
      const cfg = config as { url: string; data?: { requests?: Array<{ id: string }> } };
      if (cfg.url.includes("/$batch")) return Promise.resolve(batchAllLive(cfg)) as never;
      if (cfg.url.includes("$skiptoken=page2")) {
        return Promise.resolve({ data: { value: [graphMsg("msg-2")] } }) as never;
      }
      // first $search page → carries a nextLink to page 2
      return Promise.resolve({
        data: {
          value: [graphMsg("msg-0"), graphMsg("msg-1")],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2",
        },
      }) as never;
    });

    const results = await outlookFetchService.searchEmails({ query: "123 Main St" });

    // 2 from page 1 + 1 from page 2 = 3 (would have been 2 with the old bug)
    expect(results).toHaveLength(3);
    // a $batch existence validation was issued for the $search hits
    expect(mockAxios).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", url: expect.stringContaining("/$batch") }),
    );
  });

  it("caps pagination at 10 pages and LOUDLY reports truncation (never silent)", async () => {
    // Every page returns a full 100 and (for the $filter path) never shrinks →
    // the cap must stop the walk instead of looping forever.
    const fullPage = Array.from({ length: 100 }, (_, i) => graphMsg(`m-${i}`));
    mockAxios.mockResolvedValue({ data: { value: fullPage } });

    const results = await outlookFetchService.searchEmails({
      contactEmails: ["agent@example.com"],
      after: new Date("2026-01-01"),
    });

    // 1 count query + exactly 10 page requests = 11 calls (proves the cap held).
    expect(mockAxios).toHaveBeenCalledTimes(11);
    expect(results.length).toBe(1000);
    // truncation telemetry fired
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("pagination truncated"),
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("sent-items search matches BOTH to: and cc: recipients and paginates", async () => {
    mockAxios.mockImplementation((config: unknown) => {
      const cfg = config as { url: string; data?: { requests?: Array<{ id: string }> } };
      if (cfg.url.includes("/$batch")) return Promise.resolve(batchAllLive(cfg)) as never;
      if (cfg.url.includes("$skiptoken=sent2")) {
        return Promise.resolve({ data: { value: [graphMsg("sent-1")] } }) as never;
      }
      return Promise.resolve({
        data: {
          value: [graphMsg("sent-0")],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/sentItems/messages?$skiptoken=sent2",
        },
      }) as never;
    });

    const results = await outlookFetchService.searchSentEmailsToContacts(
      ["agent@example.com"],
      200,
      new Date("2026-01-01"),
    );

    // KQL widened to to: OR cc:
    const sentCall = mockAxios.mock.calls.find((c) => {
      const url = (c[0] as { url?: string }).url ?? "";
      return url.includes("sentItems") && url.includes("$search");
    });
    expect(sentCall).toBeDefined();
    expect(decodeURIComponent((sentCall![0] as { url: string }).url)).toContain(
      'to:agent@example.com OR cc:agent@example.com',
    );
    // both pages returned
    expect(results).toHaveLength(2);
  });

  it("validateMessageIdsExist drops ids the server 404s (kills stale $search ghosts)", async () => {
    mockAxios.mockResolvedValue({
      data: {
        responses: [
          { id: "0", status: 200 },
          { id: "1", status: 404 },
          { id: "2", status: 200 },
        ],
      },
    });

    const live = await outlookFetchService.validateMessageIdsExist(["a", "b", "c"]);
    expect(live.has("a")).toBe(true);
    expect(live.has("b")).toBe(false); // 404 → dropped
    expect(live.has("c")).toBe(true);
  });
});
