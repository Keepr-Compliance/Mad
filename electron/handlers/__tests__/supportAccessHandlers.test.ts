/**
 * @jest-environment node
 *
 * Support access IPC surface (BACKLOG-2430, BACKLOG-2428)
 *
 * The scheduler now records a capture failure and the Settings panel now
 * renders one, but both of those are held by their own suites and neither can
 * see the wire between them. Deleting `captureFailure` from this handler's
 * response would leave every other test green while the user went back to
 * being told nothing — so the wire is asserted here, on what the handler
 * actually returns.
 *
 * The scope catalogue goes out through the same call, which makes this the
 * one place that can show a user is no longer *offered* the removed scope.
 */

const registeredHandlers: Record<string, Function> = {};
jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: Function) => {
      registeredHandlers[channel] = handler;
    },
  },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetCaptureFailure = jest.fn();
const mockCaptureNow = jest.fn();
const mockGetState = jest.fn();
const mockListForDisplay = jest.fn();

jest.mock("../../services/supportAccess", () => ({
  getSupportAccess: () => ({
    access: {
      load: jest.fn().mockResolvedValue(undefined),
      reconcile: jest.fn().mockResolvedValue(false),
      getState: () => mockGetState(),
    },
    queue: {
      listForDisplay: () => mockListForDisplay(),
    },
    scheduler: {
      purgeExpiredReports: jest.fn().mockResolvedValue(undefined),
      getCaptureFailure: () => mockGetCaptureFailure(),
      captureNow: (...args: unknown[]) => mockCaptureNow(...args),
    },
  }),
}));

import { registerSupportAccessHandlers } from "../supportAccessHandlers";

const STATE = {
  active: true,
  consent: null,
  msRemaining: 1000,
  history: [],
  everGranted: true,
};

describe("support access handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetState.mockReturnValue(STATE);
    mockListForDisplay.mockResolvedValue([]);
    mockGetCaptureFailure.mockReturnValue(null);
    registerSupportAccessHandlers();
  });

  async function getState(): Promise<Record<string, unknown>> {
    return registeredHandlers["support-access:get-state"]({});
  }

  it("carries a capture failure out to the renderer", async () => {
    const failure = {
      reason: "scheduled",
      at: "2026-08-02T23:55:00.000Z",
      message: "[KeychainGate] Cannot encrypt - keychain access not yet allowed.",
    };
    mockGetCaptureFailure.mockReturnValue(failure);

    const result = await getState();

    expect(result.success).toBe(true);
    expect(result.captureFailure).toEqual(failure);
  });

  it("reports null when captures are working", async () => {
    // Not undefined: the renderer distinguishes "no failure" from "this build
    // does not send the field", and a missing key reads as the latter.
    const result = await getState();
    expect(result.captureFailure).toBeNull();
    expect(result).toHaveProperty("captureFailure");
  });

  it("no longer offers the contact-trace scope on the grant screen", async () => {
    const result = await getState();

    const offered = (result.scopes as Array<{ id: string }>).map((s) => s.id);
    expect(offered).toEqual([
      "message-import",
      "contact-resolution",
      "email-sync",
      "transaction-linking",
    ]);
    expect(result.defaultScopes).toEqual(offered);
  });

  it("serves the v3 disclosure with its own hash", async () => {
    const result = await getState();

    const disclosure = result.disclosure as { id: string; text: string; hash: string };
    expect(disclosure.id).toBe("support-access-disclosure-v3");
    expect(disclosure.hash).toHaveLength(64);
    expect(disclosure.text).not.toMatch(/people who are not Keepr users/i);
  });

  it("surfaces a manual capture failure as a failed IPC result", async () => {
    mockCaptureNow.mockRejectedValue(new Error("keychain access not yet allowed"));

    const result = await registeredHandlers["support-access:capture-now"]({});

    // wrapHandler turns the throw into a result the renderer service converts
    // back into a thrown error, which is what reaches the toast.
    expect(result).toMatchObject({
      success: false,
      error: expect.stringMatching(/keychain access not yet allowed/i),
    });
  });
});
