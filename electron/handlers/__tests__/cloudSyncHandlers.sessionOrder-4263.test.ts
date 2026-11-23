/**
 * @jest-environment node
 *
 * BACKLOG-4263 P0 — the todo watcher's sign-in restart relies on the order main subscribes to session events:
 * the installer's SessionIdentity must hear a session event (and bump its epoch) BEFORE the installer's
 * `refreshSchedule()` listener runs. authEvents iterates its listeners in subscription order; this records that
 * order through the real installer and replays an event the same way.
 */
const mockHandle = jest.fn();
jest.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: jest.fn(() => "/app") },
  ipcMain: { handle: mockHandle },
  net: { isOnline: jest.fn(() => true) },
  powerMonitor: { on: jest.fn() },
  shell: { openExternal: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({ captureMessage: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../services/db/core/dbConnection", () => ({ getRawDatabase: jest.fn() }));
jest.mock("../../services/databaseService", () => ({ __esModule: true, default: { isInitialized: jest.fn(() => false) } }));
jest.mock("../../services/initializationBroadcaster", () => ({
  initializationBroadcaster: { whenDbReady: jest.fn(() => new Promise(() => undefined)) },
}));
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getAuthUserId: jest.fn(() => null), getClient: jest.fn() },
}));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: { loadSession: jest.fn(async () => null) } }));
jest.mock("../../services/sessionSecurityService", () => ({ __esModule: true, default: { getLastActivity: jest.fn(() => null) } }));
type SessionListener = (change: { kind: "saved" | "cleared"; userId: string | null }) => void;
const mockListeners: SessionListener[] = [];
jest.mock("../../services/authEvents", () => ({
  // Same contract as the real registry: listeners are called in the order they subscribed.
  onSessionChanged: jest.fn((l: SessionListener) => {
    mockListeners.push(l);
    return () => undefined;
  }),
}));
jest.mock("../../services/deviceService", () => ({ getDeviceId: jest.fn(() => "device-4243") }));
jest.mock("../featureGateHandlers", () => ({ isStrictFeatureAllowed: jest.fn(async () => false) }));

import { installCloudSync, resetCloudSyncForTests } from "../cloudSyncHandlers";

describe("installCloudSync: session listener order (BACKLOG-4263 P0)", () => {
  beforeEach(() => {
    mockListeners.length = 0;
    resetCloudSyncForTests();
    mockHandle.mockImplementation(() => undefined);
  });

  it("the identity hears a session event before refreshSchedule runs: the epoch is already bumped when it does", () => {
    const service = installCloudSync();
    expect(service).not.toBeNull();
    expect(mockListeners.length).toBeGreaterThanOrEqual(2);
    const identity = (service as unknown as { deps: { identity: { epoch: number } } }).deps.identity;
    const seen: number[] = [];
    const refresh = jest.spyOn(service!, "refreshSchedule").mockImplementation(() => {
      seen.push(identity.epoch);
    });
    const before = identity.epoch;
    for (const l of mockListeners) l({ kind: "saved", userId: "user-a-4243" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([before + 1]);
  });
});
