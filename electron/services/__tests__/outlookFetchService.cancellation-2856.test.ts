/**
 * BACKLOG-2856 (founder live QA, 2026-08-25) — the fetch layer honours the
 * cancellation signal.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE HAS TO EXIST SEPARATELY FROM THE SERVICE-LEVEL ONE
 * ---------------------------------------------------------------------------
 * `emailSyncService.precacheCancellation-2856` mocks `outlookFetchService` away
 * entirely — that is the right shape for asserting what reaches the DATABASE,
 * and it means that suite structurally CANNOT see whether the paging loop or the
 * HTTP request ever learned about the signal. Every assertion here is about the
 * layer that suite replaces with a stub, so a regression inside the paging
 * internals would leave it green.
 *
 * The defect: `emailSyncService` held an AbortController but consulted it only
 * at phase boundaries, and one `searchAllFolders()` call spans folder discovery,
 * every folder and every Graph page. The founder measured 28.3 seconds between
 * his click and the cancel landing, by which point all 487 messages had been
 * downloaded and staged, then discarded.
 *
 * ---------------------------------------------------------------------------
 * MUTATIONS, EACH RUN IN THE FAILING DIRECTION BEFORE BEING TRUSTED
 * ---------------------------------------------------------------------------
 *   A. delete `signal` from the axios config in `_graphRequest`
 *   B. delete the pre-throttle `throwIfCancelled` in `_graphRequest`
 *   C. delete the POST-throttle `throwIfCancelled` in `_graphRequest`
 *   D. delete the between-folder check in `searchAllFolders`
 *   E. rethrow instead of returning partial on `isFetchCancelledError`
 *   F. rethrow instead of returning [] from `discoverFolders`
 *
 * ---------------------------------------------------------------------------
 * ONE MECHANISM PER BOUNDARY, BECAUSE THE FIRST DRAFT HAD TWO
 * ---------------------------------------------------------------------------
 * That draft also carried an `if (signal?.aborted) break;` at the top of every
 * page loop. The sweep showed those could be deleted with the whole suite still
 * green: `throwIfCancelled` inside `_graphRequest` already stops each loop at
 * the same boundary, so no input could separate the two. They were removed
 * rather than kept and annotated — a guard no test can red is not defence in
 * depth, it is a claim with no control.
 *
 * The between-folder check survived that cut because it does something nothing
 * else does: without it a cancelled run still ITERATES every folder (issuing no
 * requests inside each), which mutation D asserts against directly.
 */

import outlookFetchService from "../outlookFetchService";
import databaseService from "../databaseService";
import axios from "axios";
import type { OAuthToken } from "../../types/models";

jest.mock("../databaseService");
jest.mock("../microsoftAuthService");
jest.mock("axios");
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The throttler is real time the tests do not need to spend. It is a jest.fn so
// one test can also make the cancel land WHILE it is holding a call, which is
// the only window the post-throttle guard uniquely covers.
const mockThrottle = jest.fn().mockResolvedValue(undefined);
jest.mock("../../utils/apiRateLimit", () => {
  const actual = jest.requireActual("../../utils/apiRateLimit");
  return {
    ...actual,
    apiThrottlers: { microsoftGraph: { throttle: () => mockThrottle() } },
  };
});

const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>;
const mockAxios = axios as unknown as jest.Mock;

const USER = "user-cancel";
const TOKEN = {
  id: "token-id",
  user_id: USER,
  provider: "microsoft" as const,
  purpose: "mailbox" as const,
  access_token: "at",
  refresh_token: "rt",
  token_expires_at: new Date(Date.now() + 3600000).toISOString(),
  connected_email_address: "me@outlook.com",
  is_active: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as OAuthToken;

/**
 * A Graph message in the shape `_parseMessage` consumes. Transcribed from the
 * fixtures the existing Outlook suites already use against the real mapper
 * rather than invented here, so a row that comes back out of these tests is a
 * row the mapper can actually produce.
 */
function graphMessage(id: string) {
  return {
    id,
    subject: `Subject ${id}`,
    from: { emailAddress: { address: "sender@example.com", name: "Sender" } },
    toRecipients: [{ emailAddress: { address: "me@outlook.com", name: "Me" } }],
    ccRecipients: [],
    bccRecipients: [],
    receivedDateTime: "2026-03-01T10:00:00Z",
    sentDateTime: "2026-03-01T10:00:00Z",
    hasAttachments: false,
    body: { contentType: "html", content: "<html><body><p>Body</p></body></html>" },
    bodyPreview: "Body",
    conversationId: `conv-${id}`,
    internetMessageId: `<${id}@example.com>`,
    internetMessageHeaders: [],
  };
}

const PAGE_SIZE = 100;
/** A full page, so the paging loop always believes another page follows. */
const fullPage = (folder: string, page: number) =>
  Array.from({ length: PAGE_SIZE }, (_, i) => graphMessage(`${folder}-p${page}-m${i}`));

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockThrottle.mockResolvedValue(undefined);
  mockDatabaseService.getOAuthToken.mockResolvedValue(TOKEN);
  await outlookFetchService.initialize(USER);
});

describe("BACKLOG-2856 — the abort reaches the HTTP layer", () => {
  /**
   * CONTROL — asserted ON THE MOCK, not inferred from how long anything took.
   *
   * This is the assertion the founder's trace demanded: his cancel could not
   * stop the request that was already in flight, because the request never knew
   * about the signal. A timing-based assertion would have passed on the broken
   * build whenever the network happened to be quick.
   *
   * MUTATION A: drop `signal` from the axios config -> RED.
   */
  it("hands the signal to axios on every request it makes", async () => {
    const controller = new AbortController();
    mockAxios.mockResolvedValue({ data: { value: [graphMessage("m1")] } });

    await outlookFetchService.searchEmails({
      after: new Date("2026-01-01T00:00:00Z"),
      maxResults: 10,
      signal: controller.signal,
    });

    expect(mockAxios).toHaveBeenCalled();
    for (const call of mockAxios.mock.calls) {
      expect(call[0]).toHaveProperty("signal", controller.signal);
    }
  });

  /**
   * CONTROL — an abort landing while a request is in flight keeps the pages
   * already paid for, rather than unwinding the whole call.
   *
   * The distinction is not academic. `searchAllFolders` wraps each folder in a
   * try/catch that logs and CONTINUES to the next folder, so a thrown abort
   * would be swallowed there and the walk would carry on — the founder's defect
   * with extra steps. Returning partial is what makes the cancel visible to the
   * caller as "fewer rows", which is the whole point.
   *
   * MUTATION D: rethrow instead of returning partial -> RED (the call rejects).
   */
  it("keeps the pages it already had when the abort lands mid-request", async () => {
    const controller = new AbortController();
    let pages = 0;
    mockAxios.mockImplementation(async (config: { url: string }) => {
      // Keyed off the URL, not off a call counter: `searchEmails` issues a
      // `$count=true` probe before its first page, and a counter-based fixture
      // silently described a state the code does not produce.
      if (config.url.includes("$count=true")) {
        return { data: { value: [], "@odata.count": 500 } };
      }
      pages++;
      if (pages === 1) {
        return { data: { value: fullPage("inbox", 1) } };
      }
      // Page two is in flight when the user clicks Cancel. axios rejects with
      // its CanceledError; the service must read the SIGNAL, not the error.
      controller.abort();
      const err = new Error("canceled") as Error & { code?: string };
      err.code = "ERR_CANCELED";
      throw err;
    });

    const emails = await outlookFetchService.searchEmails({
      after: new Date("2026-01-01T00:00:00Z"),
      signal: controller.signal,
    });

    expect(emails).toHaveLength(PAGE_SIZE);
    expect(emails[0].id).toBe("inbox-p1-m0");
  });
});

describe("BACKLOG-2856 — the loops stop at the next boundary", () => {
  /**
   * CONTROL — request COUNT, not elapsed time.
   *
   * A mailbox deep enough to page is the case where a cancel has to land
   * promptly; before the fix the loop ran to its natural end and only then
   * returned to a boundary check.
   *
   * MUTATION B: delete the pre-throttle `throwIfCancelled` in `_graphRequest`
   * -> RED (a third page is requested).
   */
  it("stops paging a folder at the next page boundary", async () => {
    const controller = new AbortController();
    let requests = 0;
    mockAxios.mockImplementation(async () => {
      requests++;
      // The user clicks Cancel while page two is being handled.
      if (requests === 2) controller.abort();
      return { data: { value: fullPage("f1", requests) } };
    });

    const emails = await outlookFetchService.searchEmailsByFolder("folder-1", {
      after: new Date("2026-01-01T00:00:00Z"),
      maxResults: 10_000,
      signal: controller.signal,
    });

    // Two pages issued, then the loop saw the signal instead of issuing a third.
    expect(requests).toBe(2);
    expect(emails).toHaveLength(2 * PAGE_SIZE);
  });

  /**
   * CONTROL — the window the POST-throttle guard uniquely covers.
   *
   * The Graph throttler can hold a call for hundreds of milliseconds. A cancel
   * arriving inside that wait passed the pre-throttle check a moment earlier, so
   * without the second check the request goes out anyway — the user waits for a
   * page they have already asked not to be fetched. Driven by making the
   * throttle itself abort, which is exactly what "the click landed during the
   * wait" means.
   *
   * MUTATION C: delete the post-throttle `throwIfCancelled` -> RED (axios is
   * called once).
   */
  it("does not issue a request when the cancel lands while the throttler holds it", async () => {
    const controller = new AbortController();
    mockThrottle.mockImplementation(async () => {
      controller.abort();
    });
    mockAxios.mockResolvedValue({ data: { value: [graphMessage("never")] } });

    const emails = await outlookFetchService.searchEmailsByFolder("folder-1", {
      after: new Date("2026-01-01T00:00:00Z"),
      signal: controller.signal,
    });

    expect(mockAxios).not.toHaveBeenCalled();
    expect(emails).toEqual([]);
  });

  /**
   * CONTROL — the between-folder boundary, which is the one the founder's 28.3
   * seconds were spent behind.
   *
   * `precacheEmails` checks its signal between the inbox round and the
   * all-folders round, but ONE `searchAllFolders` call walks every folder, so a
   * cancel during it was not observed until the last folder had finished.
   *
   * Asserted on the FOLDER CALLS, not on the request count. Request count cannot
   * separate the two states that matter here: with the check, the walk stops
   * after folder two; without it, the walk visits all four and each one issues
   * zero requests because `_graphRequest` refuses them. Both leave the request
   * count at two, and the first draft of this test passed on the broken build
   * for exactly that reason.
   *
   * MUTATION D: delete the between-folder check -> RED (four folder calls).
   */
  it("stops walking folders at the next folder boundary", async () => {
    const controller = new AbortController();
    const byFolder = jest.spyOn(outlookFetchService, "searchEmailsByFolder");
    const foldersFetched: string[] = [];

    mockAxios.mockImplementation(async (config: { url: string }) => {
      const url = config.url;
      if (url.includes("/me/mailFolders?")) {
        return {
          data: {
            value: [
              { id: "f1", displayName: "Folder One", childFolderCount: 0 },
              { id: "f2", displayName: "Folder Two", childFolderCount: 0 },
              { id: "f3", displayName: "Folder Three", childFolderCount: 0 },
              { id: "f4", displayName: "Folder Four", childFolderCount: 0 },
            ],
          },
        };
      }
      const match = /\/me\/mailFolders\/(f\d)\/messages/.exec(url);
      if (match) {
        const folder = match[1];
        foldersFetched.push(folder);
        // Cancel arrives while the second folder is being fetched.
        if (foldersFetched.length === 2) controller.abort();
        // One short page, so each folder is exactly one request.
        return { data: { value: [graphMessage(`${folder}-only`)] } };
      }
      return { data: { value: [] } };
    });

    const emails = await outlookFetchService.searchAllFolders({
      after: new Date("2026-01-01T00:00:00Z"),
      maxResults: 10_000,
      signal: controller.signal,
    });

    expect(byFolder.mock.calls.map((c) => c[0])).toEqual(["f1", "f2"]);
    expect(foldersFetched).toEqual(["f1", "f2"]);
    // Asserted as an ID SET, not a count: a count cannot tell "stopped after two
    // folders" apart from "fetched four and deduplicated badly".
    expect(new Set(emails.map((e) => e.id))).toEqual(new Set(["f1-only", "f2-only"]));
  });

  /**
   * CONTROL — a signal that was ALREADY aborted buys nothing at all, and the
   * call RESOLVES rather than rejecting.
   *
   * Folder discovery is the first thing a multi-folder fetch does and it
   * recurses. `discoverFolders` returns empty rather than rethrowing so this
   * path finishes as a cancel, not as an Outlook FAILURE — `precacheEmails`
   * would otherwise log it as "Outlook pre-cache failed", telling the user their
   * re-cache broke when in fact they stopped it.
   *
   * MUTATION B: delete the pre-throttle guard -> RED (a request goes out).
   * MUTATION F: rethrow from `discoverFolders` -> RED (this call rejects).
   */
  it("issues no requests at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    mockAxios.mockResolvedValue({ data: { value: [graphMessage("never")] } });

    const emails = await outlookFetchService.searchAllFolders({
      after: new Date("2026-01-01T00:00:00Z"),
      signal: controller.signal,
    });

    expect(emails).toEqual([]);
    expect(mockAxios).not.toHaveBeenCalled();
    // And it did not even join the rate-limit queue. This is the one claim the
    // PRE-throttle guard makes that the post-throttle one does not: a request
    // the user has already cancelled should not take a slot from the requests
    // that are still wanted. Without this assertion mutation B stayed green.
    expect(mockThrottle).not.toHaveBeenCalled();
  });

  /**
   * CONTROL — the regression guard for every existing caller.
   *
   * The signal is optional and nothing but the pre-cache passes one. If the new
   * `signal?.aborted` checks were ever written as truthiness checks on the wrong
   * value, an ordinary sync would stop after its first page and quietly cache a
   * sliver of the mailbox — a far worse defect than the one being fixed, and one
   * no cancel test would catch.
   */
  it("pages to the end when no signal is supplied", async () => {
    let requests = 0;
    mockAxios.mockImplementation(async () => {
      requests++;
      return requests < 3
        ? { data: { value: fullPage("f1", requests) } }
        : { data: { value: [graphMessage("last")] } };
    });

    const emails = await outlookFetchService.searchEmailsByFolder("folder-1", {
      after: new Date("2026-01-01T00:00:00Z"),
      maxResults: 10_000,
    });

    expect(requests).toBe(3);
    expect(emails).toHaveLength(2 * PAGE_SIZE + 1);
  });
});
