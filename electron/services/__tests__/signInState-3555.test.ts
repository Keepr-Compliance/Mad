/**
 * BACKLOG-3555: the sign-in state module. The pending-user store and the
 * "session.json is stale" flag are one unit, so main.ts cannot store a pending
 * user and forget the flag.
 */
const mockSaveSession = jest.fn();
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { saveSession: (...a: unknown[]) => mockSaveSession(...a) },
}));

const mockLogWarn = jest.fn();
jest.mock("../logService", () => ({
  __esModule: true,
  default: { warn: (...a: unknown[]) => mockLogWarn(...a), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureMessage: (...a: unknown[]) => mockCaptureMessage(...a),
}));

import {
  SIGN_IN_WRITE_OVERDUE_MS,
  getAndClearPendingDeepLinkUser,
  getSignInGeneration,
  isSignInAwaitingSessionWrite,
  markSignInSessionWritten,
  noteSignIn,
  saveSignInSession,
  setPendingDeepLinkUser,
} from "../signInState";

// Shape main.ts builds as deepLinkUserData (PendingDeepLinkUser).
const USER = { supabaseId: "u1", email: "a@example.com", displayName: "A", provider: "google" as const };

describe("signInState (BACKLOG-3555)", () => {
  beforeEach(() => { jest.clearAllMocks(); getAndClearPendingDeepLinkUser(); markSignInSessionWritten(); });

  it("M1: storing a pending user marks session.json stale; the drain returns it and leaves the flag set; only a write clears it", () => {
    expect(isSignInAwaitingSessionWrite()).toBe(false);
    setPendingDeepLinkUser(USER);
    expect(isSignInAwaitingSessionWrite()).toBe(true);
    expect(getAndClearPendingDeepLinkUser()).toEqual(USER);
    expect(getAndClearPendingDeepLinkUser()).toBeNull();
    expect(isSignInAwaitingSessionWrite()).toBe(true);
    markSignInSessionWritten();
    expect(isSignInAwaitingSessionWrite()).toBe(false);
  });

  it("M2: every sign-in moves the generation by one; it never goes back", () => {
    const g = getSignInGeneration();
    noteSignIn(); noteSignIn();
    expect(getSignInGeneration()).toBe(g + 2);
  });

  // saveSession(): Promise<boolean>, false on a failed write (sessionService.ts:294, BACKLOG-3299).
  const DATA = { sessionToken: "t" } as never;

  it("M3: a sign-in session write that returns true ends the stale window and passes the data through", async () => {
    mockSaveSession.mockResolvedValueOnce(true);
    setPendingDeepLinkUser(USER);
    await expect(saveSignInSession(DATA)).resolves.toBe(true);
    expect(mockSaveSession).toHaveBeenCalledWith(DATA);
    expect(isSignInAwaitingSessionWrite()).toBe(false);
  });

  it("M4: a write that returns false leaves the window open", async () => {
    mockSaveSession.mockResolvedValueOnce(false);
    setPendingDeepLinkUser(USER);
    await expect(saveSignInSession(DATA)).resolves.toBe(false);
    expect(isSignInAwaitingSessionWrite()).toBe(true);
  });

  it("M5: a write that rejects leaves the window open and rethrows", async () => {
    mockSaveSession.mockRejectedValueOnce(new Error("disk"));
    setPendingDeepLinkUser(USER);
    await expect(saveSignInSession(DATA)).rejects.toThrow("disk");
    expect(isSignInAwaitingSessionWrite()).toBe(true);
  });

  describe("M6: a session write that never succeeds is reported once, after the bound", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => { markSignInSessionWritten(); jest.useRealTimers(); });

    it("M6a: flag still set after SIGN_IN_WRITE_OVERDUE_MS -> one log warning and one Sentry message, never repeated", async () => {
      expect(SIGN_IN_WRITE_OVERDUE_MS).toBe(60_000);
      mockSaveSession.mockResolvedValue(false);
      setPendingDeepLinkUser(USER);
      await saveSignInSession(DATA); // the persist failed: flag stays set
      jest.advanceTimersByTime(SIGN_IN_WRITE_OVERDUE_MS - 1);
      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(mockLogWarn).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "Sign-in session write overdue",
        expect.objectContaining({ level: "warning", extra: { waitedMs: SIGN_IN_WRITE_OVERDUE_MS } }),
      );
      setPendingDeepLinkUser(USER); // a second pending user while still stuck: no second alarm
      jest.advanceTimersByTime(10 * SIGN_IN_WRITE_OVERDUE_MS);
      expect(mockLogWarn).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it("M6b: the session write succeeds within the bound -> nothing reported", async () => {
      mockSaveSession.mockResolvedValue(true);
      setPendingDeepLinkUser(USER);
      jest.advanceTimersByTime(SIGN_IN_WRITE_OVERDUE_MS - 1);
      await saveSignInSession(DATA);
      jest.advanceTimersByTime(10 * SIGN_IN_WRITE_OVERDUE_MS);
      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(mockCaptureMessage).not.toHaveBeenCalled();
    });

    it("M6c: after a successful write, a later stuck sign-in is reported again (the alarm re-arms)", async () => {
      setPendingDeepLinkUser(USER);
      markSignInSessionWritten();
      setPendingDeepLinkUser(USER);
      jest.advanceTimersByTime(SIGN_IN_WRITE_OVERDUE_MS);
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    });

    it("M6d: a successful write disarms its own alarm; the next sign-in is reported at its own deadline, not early", () => {
      setPendingDeepLinkUser(USER); // sign-in 1
      jest.advanceTimersByTime(SIGN_IN_WRITE_OVERDUE_MS / 2);
      markSignInSessionWritten(); // sign-in 1 written
      setPendingDeepLinkUser(USER); // sign-in 2
      jest.advanceTimersByTime(SIGN_IN_WRITE_OVERDUE_MS / 2); // sign-in 1's old deadline passes
      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(mockCaptureMessage).not.toHaveBeenCalled();
      jest.advanceTimersByTime(SIGN_IN_WRITE_OVERDUE_MS / 2); // sign-in 2's deadline
      expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        "Sign-in session write overdue",
        expect.objectContaining({ extra: { waitedMs: SIGN_IN_WRITE_OVERDUE_MS } }),
      );
    });
  });
});
