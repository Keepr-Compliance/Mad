/**
 * Renderer support-access service (BACKLOG-2430)
 *
 * The last untested hop in the chain that tells a user support is receiving
 * nothing: scheduler records the failure, the handler puts it on the wire, this
 * maps it into the snapshot the panel reads. Dropping the mapping here would
 * leave the scheduler suite, the handler suite and the component suite all
 * green while the banner silently stopped appearing.
 */

import { getSnapshot } from "../supportAccessService";

const mockGetState = jest.fn();

interface WindowWithApi extends Window {
  api?: unknown;
}

function installBridge(): void {
  (window as WindowWithApi).api = {
    support: {
      access: {
        getState: () => mockGetState(),
      },
    },
  };
}

const BASE = {
  success: true,
  state: {
    active: true,
    consent: null,
    msRemaining: 1000,
    history: [],
    everGranted: true,
  },
  reports: [],
  durations: [],
  defaultDurationId: "7d",
  scopes: [],
  defaultScopes: [],
  disclosure: { id: "support-access-disclosure-v3", text: "Wording.", hash: "h" },
  retentionDays: 30,
};

describe("getSnapshot", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installBridge();
  });

  afterEach(() => {
    delete (window as WindowWithApi).api;
  });

  it("carries a capture failure through to the panel", async () => {
    const captureFailure = {
      reason: "scheduled" as const,
      at: "2026-08-02T23:55:00.000Z",
      message: "[KeychainGate] Cannot encrypt - keychain access not yet allowed.",
    };
    mockGetState.mockResolvedValue({ ...BASE, captureFailure });

    const snapshot = await getSnapshot();

    expect(snapshot.captureFailure).toEqual(captureFailure);
  });

  it("normalises an absent failure to null rather than undefined", async () => {
    // The panel renders on truthiness, so undefined would work by accident —
    // but a snapshot that omits the key entirely is indistinguishable from an
    // older main process, and that is worth keeping explicit.
    mockGetState.mockResolvedValue({ ...BASE });

    const snapshot = await getSnapshot();

    expect(snapshot.captureFailure).toBeNull();
    expect(snapshot).toHaveProperty("captureFailure");
  });

  it("throws rather than returning a half-built snapshot", async () => {
    mockGetState.mockResolvedValue({ success: false, error: "no support access" });

    await expect(getSnapshot()).rejects.toThrow(/no support access/);
  });
});
