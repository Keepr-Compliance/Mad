/**
 * BACKLOG-1831: unit tests for the SHADOW-mode delta orchestrator.
 *
 * Covers:
 *  - per-folder cursor persisted AFTER each folder completes (crash-safe)
 *  - single-flight guard (overlapping ticks don't double-run)
 *  - failure_count backoff skip (unhealthy account is left alone)
 *  - 410 DeltaTokenExpiredError clears that folder's cursor
 *  - start()/stop() timer scheduling (2m first run, 15m poll, cleared on stop)
 *
 * All collaborators are mocked so no network / native modules are touched.
 */

const mockStore = jest.fn();
jest.mock("../emailSyncService", () => ({
  __esModule: true,
  storeParsedEmailsForAccount: (...args: unknown[]) => mockStore(...args),
}));

const mockResolve = jest.fn();
const mockEnsure = jest.fn();
const mockGetState = jest.fn();
const mockGetCursor = jest.fn();
const mockSetCursor = jest.fn();
const mockRecordSuccess = jest.fn();
const mockRecordFailure = jest.fn();
jest.mock("../db/emailSyncStateService", () => ({
  resolveMailboxAccountId: (...a: unknown[]) => mockResolve(...a),
  ensureSyncStateRow: (...a: unknown[]) => mockEnsure(...a),
  getSyncState: (...a: unknown[]) => mockGetState(...a),
  getCursor: (...a: unknown[]) => mockGetCursor(...a),
  setCursor: (...a: unknown[]) => mockSetCursor(...a),
  recordSyncSuccess: (...a: unknown[]) => mockRecordSuccess(...a),
  recordSyncFailure: (...a: unknown[]) => mockRecordFailure(...a),
}));

jest.mock("../outlookFetchService", () => {
  class DeltaTokenExpiredError extends Error {
    folderId: string;
    constructor(folderId: string) {
      super(`expired ${folderId}`);
      this.name = "DeltaTokenExpiredError";
      this.folderId = folderId;
    }
  }
  return {
    __esModule: true,
    default: {
      initialize: jest.fn(),
      discoverFolders: jest.fn(),
      fetchDeltaEmails: jest.fn(),
    },
    DeltaTokenExpiredError,
  };
});

// Dynamically-imported deps of maybeStartShadowDeltaSync (flag + mailbox gating).
const mockIsEnabled = jest.fn();
jest.mock("../../utils/preferenceHelper", () => ({
  isShadowDeltaSyncEnabled: (...a: unknown[]) => mockIsEnabled(...a),
}));
const mockGetOAuthToken = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a) },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

import shadowDeltaSyncService, { maybeStartShadowDeltaSync } from "../shadowDeltaSyncService";
import outlookFetchService, { DeltaTokenExpiredError } from "../outlookFetchService";

const outlook = outlookFetchService as unknown as {
  initialize: jest.Mock;
  discoverFolders: jest.Mock;
  fetchDeltaEmails: jest.Mock;
};

const USER = "user-1";
const ACCT = "acct-ms-1";

describe("shadowDeltaSyncService (BACKLOG-1831)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    shadowDeltaSyncService.stop();
    mockResolve.mockReturnValue(ACCT);
    mockGetState.mockReturnValue(undefined); // no row → active, healthy
    mockGetCursor.mockReturnValue(null);
    mockStore.mockResolvedValue({ fetched: 0, stored: 0, errors: 0, duplicates: 0 });
    outlook.initialize.mockResolvedValue(true);
    outlook.discoverFolders.mockResolvedValue([]);
    outlook.fetchDeltaEmails.mockResolvedValue({ emails: [], deltaLink: null, removedSkipped: 0 });
  });

  afterEach(() => {
    shadowDeltaSyncService.stop();
  });

  it("persists each folder's cursor AFTER that folder completes (cumulative map)", async () => {
    outlook.discoverFolders.mockResolvedValue([
      { id: "f1", displayName: "Inbox" },
      { id: "f2", displayName: "Archive" },
    ]);
    outlook.fetchDeltaEmails.mockImplementation((folderId: string) =>
      Promise.resolve({
        emails: [{ id: `${folderId}-msg` }],
        deltaLink: `delta-${folderId}`,
        removedSkipped: 0,
      }),
    );
    mockStore.mockResolvedValue({ fetched: 1, stored: 1, errors: 0, duplicates: 0 });

    await shadowDeltaSyncService.runOnce(USER);

    expect(mockEnsure).toHaveBeenCalledWith(USER, ACCT, "microsoft");
    expect(mockSetCursor).toHaveBeenCalledTimes(2);

    const firstMap = JSON.parse((mockSetCursor.mock.calls[0] as unknown[])[2] as string);
    expect(firstMap).toEqual({ f1: "delta-f1" });

    const secondMap = JSON.parse((mockSetCursor.mock.calls[1] as unknown[])[2] as string);
    expect(secondMap).toEqual({ f1: "delta-f1", f2: "delta-f2" });

    expect(mockRecordSuccess).toHaveBeenCalledWith(USER, ACCT, "microsoft");
    expect(mockStore).toHaveBeenCalledTimes(2);
  });

  it("single-flight guard: an overlapping tick does not start a second run", async () => {
    let releaseInit: () => void = () => {};
    outlook.initialize.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseInit = () => resolve(true);
      }),
    );

    const p1 = shadowDeltaSyncService.runOnce(USER); // sets isRunning, then awaits init
    const p2 = shadowDeltaSyncService.runOnce(USER); // should short-circuit
    await p2;

    // Only the first run got as far as initialize().
    expect(outlook.initialize).toHaveBeenCalledTimes(1);

    releaseInit();
    await p1;
    expect(outlook.initialize).toHaveBeenCalledTimes(1);
  });

  it("skips the run when failure_count is at/over the backoff threshold", async () => {
    mockGetState.mockReturnValue({ phase: "active", failure_count: 5 });

    await shadowDeltaSyncService.runOnce(USER);

    expect(outlook.initialize).not.toHaveBeenCalled();
    expect(outlook.discoverFolders).not.toHaveBeenCalled();
    expect(mockRecordSuccess).not.toHaveBeenCalled();
    expect(mockRecordFailure).not.toHaveBeenCalled();
  });

  it("skips when the account phase is not 'active' (respects Clear)", async () => {
    mockGetState.mockReturnValue({ phase: "cleared", failure_count: 0 });

    await shadowDeltaSyncService.runOnce(USER);

    expect(outlook.initialize).not.toHaveBeenCalled();
  });

  it("clears the folder cursor on DeltaTokenExpiredError (410) and still succeeds", async () => {
    outlook.discoverFolders.mockResolvedValue([{ id: "f1", displayName: "Inbox" }]);
    mockGetCursor.mockReturnValue(JSON.stringify({ f1: "old-link" }));
    outlook.fetchDeltaEmails.mockRejectedValue(new DeltaTokenExpiredError("f1"));

    await shadowDeltaSyncService.runOnce(USER);

    expect(mockSetCursor).toHaveBeenCalledTimes(1);
    const map = JSON.parse((mockSetCursor.mock.calls[0] as unknown[])[2] as string);
    expect(map).toEqual({}); // f1 removed
    expect(mockRecordSuccess).toHaveBeenCalledWith(USER, ACCT, "microsoft");
  });

  it("does nothing when there is no Microsoft mailbox account", async () => {
    mockResolve.mockReturnValue(null);

    await shadowDeltaSyncService.runOnce(USER);

    expect(outlook.initialize).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  describe("start / stop scheduling", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      shadowDeltaSyncService.stop();
      jest.useRealTimers();
    });

    it("first run at ~2 min, then every 15 min; stop() clears the timers", () => {
      const runSpy = jest
        .spyOn(shadowDeltaSyncService, "runOnce")
        .mockResolvedValue(undefined);

      shadowDeltaSyncService.start(USER);
      expect(runSpy).not.toHaveBeenCalled(); // nothing immediate

      jest.advanceTimersByTime(2 * 60 * 1000);
      expect(runSpy).toHaveBeenCalledTimes(1); // first run

      jest.advanceTimersByTime(15 * 60 * 1000);
      expect(runSpy).toHaveBeenCalledTimes(2); // one poll tick

      shadowDeltaSyncService.stop();
      jest.advanceTimersByTime(60 * 60 * 1000);
      expect(runSpy).toHaveBeenCalledTimes(2); // no more ticks after stop

      runSpy.mockRestore();
    });

    it("start() is idempotent — a second call does not double-schedule", () => {
      const runSpy = jest
        .spyOn(shadowDeltaSyncService, "runOnce")
        .mockResolvedValue(undefined);

      shadowDeltaSyncService.start(USER);
      shadowDeltaSyncService.start(USER); // no-op

      jest.advanceTimersByTime(2 * 60 * 1000);
      expect(runSpy).toHaveBeenCalledTimes(1); // not 2

      runSpy.mockRestore();
    });
  });
});

// The shared boot entry point called from BOTH the OAuth-callback (main.ts) and
// the restored-session boot path (sessionHandlers.handleGetCurrentUser). Both call
// sites are thin wrappers over this, so exercising it here covers the
// restored-session fix (BACKLOG-1831 defect: returning users never started the
// poller because the wiring lived only in the OAuth callback).
describe("maybeStartShadowDeltaSync (BACKLOG-1831 shared boot entry)", () => {
  let startSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    startSpy = jest.spyOn(shadowDeltaSyncService, "start").mockImplementation(() => {});
    mockIsEnabled.mockResolvedValue(true);
    mockGetOAuthToken.mockResolvedValue({ id: "tok-1" });
  });

  afterEach(() => {
    startSpy.mockRestore();
    shadowDeltaSyncService.stop();
  });

  it("starts the poller when the flag is ON and a Microsoft mailbox exists (restored-session path)", async () => {
    await maybeStartShadowDeltaSync(USER);
    expect(mockIsEnabled).toHaveBeenCalledWith(USER);
    expect(mockGetOAuthToken).toHaveBeenCalledWith(USER, "microsoft", "mailbox");
    expect(startSpy).toHaveBeenCalledWith(USER);
  });

  it("does NOT start when the flag is OFF (and skips the mailbox lookup)", async () => {
    mockIsEnabled.mockResolvedValue(false);
    await maybeStartShadowDeltaSync(USER);
    expect(startSpy).not.toHaveBeenCalled();
    expect(mockGetOAuthToken).not.toHaveBeenCalled();
  });

  it("does NOT start when the flag is ON but no Microsoft mailbox is connected", async () => {
    mockGetOAuthToken.mockResolvedValue(null);
    await maybeStartShadowDeltaSync(USER);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
