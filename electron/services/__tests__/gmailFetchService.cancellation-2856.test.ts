/**
 * BACKLOG-2856 — the Gmail fetch layer honours the cancellation signal.
 *
 * The founder's trace was an Outlook run, so Gmail was CHECKED rather than
 * assumed to differ — and it had the same gap, in a worse place. Gmail's list
 * call returns bare message IDs; every body is a separate `messages.get`, run in
 * batches of ten. On a real mailbox that detail loop, not the paging above it,
 * is where nearly all the time goes, so a cancel that only reached the paging
 * would still have left the user waiting out the whole download.
 *
 * Companion to `outlookFetchService.cancellation-2856`. Same rule about one
 * mechanism per boundary: `throwIfCancelled` inside `_throttledCall` stops every
 * page and detail loop, and the between-LABEL check is kept separately because
 * it alone stops the walk.
 *
 * MUTATIONS, each run in the failing direction:
 *   A. delete `{ signal }` from the `messages.list` / `messages.get` options
 *   B. delete the pre-throttle `throwIfCancelled` in `_throttledCall`
 *   C. delete the post-throttle `throwIfCancelled` in `_throttledCall`
 *   D. delete the between-label check in `searchAllLabels`
 *   E. rethrow instead of breaking on `isFetchCancelledError` in the detail loop
 *   F. classify the abort by the gaxios error shape instead of by the signal
 */

import gmailFetchService from "../gmailFetchService";
import databaseService from "../databaseService";
import { google } from "googleapis";
import type { OAuthToken } from "../../types/models";

jest.mock("../databaseService");
jest.mock("googleapis");
jest.mock("google-auth-library");
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: (...a: unknown[]) => mockLog.info(...a),
    warn: (...a: unknown[]) => mockLog.warn(...a),
    error: (...a: unknown[]) => mockLog.error(...a),
    debug: (...a: unknown[]) => mockLog.debug(...a),
  },
}));

// A jest.fn so one test can make the cancel land WHILE the throttler holds the
// call — the only window the post-throttle guard uniquely covers.
const mockThrottle = jest.fn().mockResolvedValue(undefined);
jest.mock("../../utils/apiRateLimit", () => {
  const actual = jest.requireActual("../../utils/apiRateLimit");
  return {
    ...actual,
    apiThrottlers: { gmail: { throttle: () => mockThrottle() } },
  };
});

const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>;
const mockMessagesList = jest.fn();
const mockMessagesGet = jest.fn();
const mockLabelsList = jest.fn();

const USER = "user-cancel";
const TOKEN = {
  id: "token-id",
  user_id: USER,
  provider: "google" as const,
  purpose: "mailbox" as const,
  access_token: "at",
  refresh_token: "rt",
  token_expires_at: new Date(Date.now() + 3600000).toISOString(),
  connected_email_address: "me@gmail.com",
  is_active: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as OAuthToken;

/** The `messages.get` shape, transcribed from the existing Gmail suite. */
const fullMessage = (id: string) => ({
  data: {
    id,
    threadId: `thread-${id}`,
    internalDate: "1772000000000",
    snippet: "snippet",
    labelIds: ["INBOX"],
    payload: {
      headers: [
        { name: "Subject", value: `Subject ${id}` },
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "me@gmail.com" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from("Body text").toString("base64") },
    },
  },
});

beforeEach(async () => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockThrottle.mockResolvedValue(undefined);

  (google.auth.OAuth2 as unknown as jest.Mock).mockImplementation(() => ({
    setCredentials: jest.fn(),
    on: jest.fn(),
  }));
  (google.gmail as unknown as jest.Mock).mockReturnValue({
    users: {
      messages: { list: mockMessagesList, get: mockMessagesGet },
      labels: { list: mockLabelsList },
      getProfile: jest.fn(),
    },
  });

  mockMessagesGet.mockImplementation(async (params: { id: string }) => fullMessage(params.id));
  mockDatabaseService.getOAuthToken.mockResolvedValue(TOKEN);
  await gmailFetchService.initialize(USER);
});

describe("BACKLOG-2856 — the abort reaches the Gmail HTTP layer", () => {
  /**
   * CONTROL — asserted ON THE MOCK. `MethodOptions` extends gaxios' options,
   * which carry `signal`; without it the request cannot be torn down and a
   * cancel can only ever be honoured between calls.
   *
   * MUTATION A -> RED.
   */
  it("hands the signal to gaxios on the list and detail calls", async () => {
    const controller = new AbortController();
    mockMessagesList.mockResolvedValue({ data: { messages: [{ id: "m1" }], resultSizeEstimate: 1 } });

    await gmailFetchService.searchEmails({
      after: new Date("2026-01-01T00:00:00Z"),
      maxResults: 1,
      signal: controller.signal,
    });

    expect(mockMessagesList).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
    expect(mockMessagesGet).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });

  /**
   * CONTROL — the detail loop, which is Gmail's long phase.
   *
   * 25 message IDs, batched ten at a time. The cancel is fired from inside the
   * TENTH `messages.get`, i.e. as batch one finishes: batch one is kept in full
   * and batches two and three are never started. Written at the batch boundary
   * on purpose — firing it mid-batch would make the result depend on the order
   * in which ten concurrent promises settle, which is how a test becomes flaky.
   * What happens mid-batch is documented at the loop instead (that batch is
   * dropped), because no assertion could pin it without pinning microtask order.
   *
   * MUTATION E -> RED (the call rejects instead of returning batch one).
   * MUTATION C -> RED (all 25 detail calls are made).
   */
  it("stops fetching message bodies at the next batch boundary", async () => {
    const controller = new AbortController();
    const ids = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}` }));
    mockMessagesList.mockResolvedValue({ data: { messages: ids, resultSizeEstimate: 25 } });

    let gets = 0;
    mockMessagesGet.mockImplementation(async (params: { id: string }) => {
      gets++;
      // The user clicks Cancel as the tenth body of batch one comes back.
      if (gets === 10) controller.abort();
      return fullMessage(params.id);
    });

    const emails = await gmailFetchService.searchEmails({
      after: new Date("2026-01-01T00:00:00Z"),
      maxResults: 25,
      signal: controller.signal,
    });

    expect(emails).toHaveLength(10);
    expect(gets).toBe(10);
    // Asserted as an ID SET: a count alone cannot separate "batch one" from
    // "ten arbitrary messages".
    expect(new Set(emails.map((e) => e.id))).toEqual(
      new Set(ids.slice(0, 10).map((m) => m.id)),
    );
  });

  /**
   * CONTROL — the window the POST-throttle guard uniquely covers: the cancel
   * arrives while the Gmail throttler is holding the call.
   *
   * MUTATION C -> RED (the list call goes out anyway).
   */
  it("does not issue a request when the cancel lands while the throttler holds it", async () => {
    const controller = new AbortController();
    mockThrottle.mockImplementation(async () => {
      controller.abort();
    });
    mockMessagesList.mockResolvedValue({ data: { messages: [{ id: "never" }] } });

    const emails = await gmailFetchService.searchEmails({
      after: new Date("2026-01-01T00:00:00Z"),
      signal: controller.signal,
    });

    expect(mockMessagesList).not.toHaveBeenCalled();
    expect(emails).toEqual([]);
  });

  /**
   * CONTROL — an abort classified by the SIGNAL, not by the gaxios error shape.
   *
   * `withRetry` treats network-ish errors as transient. A cancel misread as
   * transient would turn the user's Cancel into MORE requests, not fewer, so the
   * classification asks the signal we ourselves passed.
   *
   * This control found a real defect: the conversion was first written AROUND
   * `withRetry` rather than inside it, so gaxios' network-ish rejection was read
   * as transient and five exponential backoffs — 31 seconds — ran before the
   * cancel was recognised. The test timed out rather than passing slowly, which
   * is the only reason it was noticed.
   *
   * MUTATION F -> RED (the abort is retried, and the test times out).
   */
  it("treats an in-flight rejection as a cancel when the signal is aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    mockMessagesList.mockImplementation(async () => {
      calls++;
      controller.abort();
      const err = new Error("The user aborted a request.") as Error & { code?: string };
      err.code = "ECONNRESET"; // a code `isRetryableError` DOES retry
      throw err;
    });

    const emails = await gmailFetchService.searchEmails({
      after: new Date("2026-01-01T00:00:00Z"),
      signal: controller.signal,
    });

    expect(emails).toEqual([]);
    expect(calls).toBe(1); // the request itself was issued once

    // AND the abort was never SCHEDULED for a retry. This is the half that
    // `calls` cannot see: without the conversion, `withRetry` reads gaxios'
    // network-ish error as transient, logs this line, sleeps a full backoff, and
    // only then hits the guard at the top of the next attempt — so `calls` still
    // reads 1 while the user waits an extra second per cancel, and five seconds
    // where the mailbox is slow enough to abort mid-request repeatedly.
    const retryLogs = mockLog.debug.mock.calls.filter((c) =>
      String(c[0]).includes("Transient error. Retry"),
    );
    expect(retryLogs).toEqual([]);
  });
});

describe("BACKLOG-2856 — the Gmail label walk stops", () => {
  /**
   * CONTROL — the between-label boundary, Gmail's counterpart to the
   * between-folder check. Asserted on the LABEL CALLS, not the request count:
   * without the check the walk still visits every label, each issuing no
   * requests, which leaves the request count identical.
   *
   * MUTATION D -> RED (all four labels visited).
   */
  it("stops walking labels at the next label boundary", async () => {
    const controller = new AbortController();
    const byLabel = jest.spyOn(gmailFetchService, "searchEmailsByLabel");
    mockLabelsList.mockResolvedValue({
      data: {
        labels: [
          { id: "L1", name: "One", type: "user" },
          { id: "L2", name: "Two", type: "user" },
          { id: "L3", name: "Three", type: "user" },
          { id: "L4", name: "Four", type: "user" },
        ],
      },
    });

    const visited: string[] = [];
    mockMessagesList.mockImplementation(async (params: { labelIds?: string[] }) => {
      const label = params.labelIds?.[0] ?? "?";
      visited.push(label);
      if (visited.length === 2) controller.abort();
      return { data: { messages: [{ id: `${label}-only` }] } };
    });

    const emails = await gmailFetchService.searchAllLabels({
      after: new Date("2026-01-01T00:00:00Z"),
      signal: controller.signal,
    });

    expect(byLabel.mock.calls.map((c) => c[0])).toEqual(["L1", "L2"]);
    // L2 aborted mid-round, so only L1's body was fetched. The set, not the
    // count, is what pins which messages survived.
    expect(new Set(emails.map((e) => e.id))).toEqual(new Set(["L1-only"]));
  });

  /**
   * CONTROL — an already-aborted signal buys nothing, the call RESOLVES rather
   * than rejecting, and the request never joins the rate-limit queue.
   *
   * `discoverLabels` returns empty rather than rethrowing so this finishes as a
   * cancel; a rethrow would surface in `precacheEmails` as "Gmail pre-cache
   * failed", telling the user their re-cache broke when they stopped it.
   *
   * MUTATION B -> RED (the throttle assertion).
   */
  it("issues nothing at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    mockLabelsList.mockResolvedValue({ data: { labels: [{ id: "L1", name: "One" }] } });

    const emails = await gmailFetchService.searchAllLabels({
      after: new Date("2026-01-01T00:00:00Z"),
      signal: controller.signal,
    });

    expect(emails).toEqual([]);
    expect(mockLabelsList).not.toHaveBeenCalled();
    expect(mockThrottle).not.toHaveBeenCalled();
  });

  /**
   * CONTROL — the regression guard for every existing caller.
   *
   * The signal is optional and nothing but the pre-cache passes one. Were any of
   * the new checks written against the wrong value, an ordinary sync would stop
   * after its first batch and quietly cache a sliver of the mailbox — a worse
   * defect than the one being fixed, and one no cancel test would catch.
   */
  it("fetches every body when no signal is supplied", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}` }));
    mockMessagesList.mockResolvedValue({ data: { messages: ids, resultSizeEstimate: 25 } });

    const emails = await gmailFetchService.searchEmails({
      after: new Date("2026-01-01T00:00:00Z"),
      maxResults: 25,
    });

    expect(emails).toHaveLength(25);
  });
});
