/**
 * @jest-environment node
 */
/**
 * BACKLOG-4076: while a deep-link sign-in waits for its session write,
 * session.json still holds the PREVIOUS user. Every reader of the file is
 * refused until the sign-in write succeeds (or the app relaunches):
 * sessionService.loadSession() returns null without reading the file and
 * peekSession() reports "unreadable". The flag lives in the leaf module
 * sessionFileState and is cleared inside the serialized sign-in write, only
 * when that write succeeded.
 *
 * Real sessionService, real signInState, real sessionFileState, real
 * syncHandlers identity code. fs, electron, the Supabase SDK and the idle
 * enforcer's collaborators are mocked.
 *
 * Traced mechanisms these controls pin (at 08c053bbd):
 *
 * P3 (token write-back into the OLD file): supabaseService.ts:643
 *   TOKEN_REFRESHED -> :662-668 sessionService.updateSession({ supabaseTokens })
 *   -> loadSession() (OLD file) -> merge { ...currentSession, ...updates }
 *   -> _writeSession. Without the fix the file becomes OLD user + the NEW
 *   user's rotated tokens, and the next launch restores the OLD local user on
 *   the NEW user's tokens.
 *   Timing on the normal path: the window opens on freshly issued tokens
 *   (main.ts:670 setSession), so a rotation inside a seconds-long window is
 *   improbable - UNTRACED, not expected. With a stranded flag (a failed or
 *   skipped persist) it is expected: the SDK rotates about hourly for the rest
 *   of the run.
 *
 * P5 (idle tick signs the NEW user out): authHandlers.ts:87 starts the 60 s
 *   tick -> sessionIdleEnforcer.ts:45 (DB open) -> :46 peekSession() = OLD
 *   file -> :51 getSessionTimes(OLD token) -> checkSessionValidity idle ->
 *   :63 signOutLocalSession for the OLD row (sessionSignOut.ts:171-204; it
 *   also calls sessionService.clearSession(), which may remove the NEW
 *   session.json if queued after the sign-in write - ordering UNTRACED) ->
 *   :67 session:idle-expired -> authBridge.ts:254 -> useIdleSessionExpiry.ts:29
 *   -> AppShell.tsx:52 handleLogout: the NEW user is sent to the sign-in
 *   screen with a false "signed out after 30 minutes of inactivity" message.
 *
 * Behaviour change, unmeasured here: permissionHandlers.ts:39 (FDA relaunch
 * safety net) now sees null while the flag is set, so it flushes a session
 * for the SDK (new) user before relaunching; the relaunched process starts
 * with that file and no flag.
 *
 * Fixtures: session shape transcribed from systemHandlers.ts
 * persistSessionForUser (:220-238); pending-user shape from main.ts:849;
 * safeStorage mock from sessionService.test.ts; sync harness from
 * syncHandlers.atRestRefused-3816.test.ts (sessionService NOT mocked); idle
 * collaborators from the 4076 plan/SR probes (sessionIdleEnforcer.ts:45-67).
 */
import { EventEmitter } from "events";

const mockHandlers = new Map<string, (...a: unknown[]) => unknown>();
jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  ipcMain: {
    handle: jest.fn((c: string, fn: (...a: unknown[]) => unknown) => mockHandlers.set(c, fn)),
    removeHandler: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  },
  BrowserWindow: jest.fn(),
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: jest.fn((buf: Buffer) => {
      const s = buf.toString();
      if (s.startsWith("encrypted:")) return s.slice(10);
      throw new Error("not encrypted");
    }),
  },
}));

// session.json on "disk"
let mockDisk: string | null = null;
let mockTmp: string | null = null;
let mockReads = 0;
let mockWriteFail = false;
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: jest.fn(async (p: string, ...rest: unknown[]) => {
        if (String(p).endsWith("session.json")) {
          mockReads += 1;
          if (mockDisk === null) {
            const e = new Error("ENOENT") as NodeJS.ErrnoException;
            e.code = "ENOENT";
            throw e;
          }
          return mockDisk;
        }
        return actual.promises.readFile(p, ...rest);
      }),
      writeFile: jest.fn(async (p: string, c: string) => {
        if (mockWriteFail) throw new Error("EIO");
        if (String(p).endsWith("session.json.tmp")) mockTmp = c;
      }),
      rename: jest.fn(async () => {
        mockDisk = mockTmp;
      }),
      unlink: jest.fn(async (p: string) => {
        if (String(p).endsWith("session.json")) mockDisk = null;
      }),
      mkdir: jest.fn(async () => undefined),
    },
  };
});

const mockLog = {
  info: jest.fn().mockResolvedValue(undefined),
  warn: jest.fn().mockResolvedValue(undefined),
  error: jest.fn().mockResolvedValue(undefined),
  debug: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../logService", () => ({ __esModule: true, default: mockLog, logService: mockLog }));
jest.mock("@sentry/electron/main", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
}));

// sync harness (syncHandlers.atRestRefused-3816.test.ts)
const orchestratorEvents = Object.assign(new EventEmitter(), {
  processExistingBackup: jest.fn(),
  getStatus: jest.fn().mockReturnValue({ isRunning: false }),
  forceReset: jest.fn(),
  cleanupBackup: jest.fn(),
  startDeviceDetection: jest.fn(),
  stopDeviceDetection: jest.fn(),
});
jest.mock("../deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: orchestratorEvents,
  DeviceSyncOrchestrator: class {},
}));
jest.mock("../iPhoneSyncStorageService", () => ({
  iPhoneSyncStorageService: { persistSyncResult: jest.fn() },
  attachmentSkipFields: jest.fn(() => ({})),
}));
jest.mock("../autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn(),
  expandAttachedThreadsForUser: jest.fn(),
}));
jest.mock("../syncStatusService", () => ({ syncStatusService: {} }));
jest.mock("../syncTimeline", () => ({
  syncTimeline: {
    enter: jest.fn(),
    endSync: jest.fn(),
    annotate: jest.fn(),
    markStorageCompleteSent: jest.fn(),
    noteRendererTick: jest.fn(),
    markCompletionShown: jest.fn(),
  },
}));

// SDK: after main.ts:670 setSession it holds the NEW user.
let mockSdkUserId: string | null = "new-user";
const mockEqCalls: Array<[string, unknown]> = [];
jest.mock("../supabaseService", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (k: string, v: unknown) => {
    mockEqCalls.push([k, v]);
    return chain;
  };
  chain.single = async () => ({ data: { last_sync_time: "t" }, error: null });
  return {
    __esModule: true,
    default: {
      getAuthUserId: () => mockSdkUserId,
      getClient: () => ({
        from: () => chain,
        auth: {
          getSession: async () => ({
            data: { session: mockSdkUserId ? { user: { id: mockSdkUserId } } : null },
          }),
        },
      }),
    },
  };
});

// Idle enforcer collaborators. DB open (W-b, databaseService.ts:354); the OLD
// user's session row exists and is idle-expired.
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: () => true,
    getSessionTimes: (t: string) =>
      t === "st-old-user"
        ? {
            user_id: "old-user",
            created_at: "2026-10-01 00:00:00",
            last_accessed_at: "2026-10-01 00:00:00",
            expires_at: "2099-01-01 00:00:00",
          }
        : null,
  },
}));
jest.mock("../sessionSecurityService", () => ({
  __esModule: true,
  default: {
    checkSessionValidity: jest.fn(async () => ({ valid: false, reason: "idle" })),
    recordActivity: jest.fn(),
  },
}));
const mockSignOut = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../handlers/sessionSignOut", () => ({
  signOutLocalSession: (...a: unknown[]) => mockSignOut(...a),
}));
const mockSendToMainWindow = jest.fn();
jest.mock("../../windowRegistry", () => ({
  sendToMainWindow: (...a: unknown[]) => mockSendToMainWindow(...a),
  getMainWindow: () => null,
}));

import sessionService from "../sessionService";
import { enforceSessionIdle } from "../sessionIdleEnforcer";
import {
  getAndClearPendingDeepLinkUser,
  isSignInAwaitingSessionWrite,
  markSignInSessionWritten,
  noteSignIn,
  saveSignInSession,
  setPendingDeepLinkUser,
} from "../signInState";
import { registerSyncHandlers, setSyncUserId } from "../../handlers/syncHandlers";

// Session shape: systemHandlers.ts persistSessionForUser (:220-238).
function sessionFor(id: string, email: string, token: string) {
  return {
    user: { id, email, display_name: email.split("@")[0] } as never,
    sessionToken: `st-${id}`,
    provider: "google" as const,
    subscription: {
      tier: "free",
      status: "trial",
      isActive: true,
      isTrial: true,
      trialEnded: false,
      trialDaysRemaining: 0,
    } as never,
    expiresAt: Date.now() + 86_400_000,
    createdAt: Date.now(),
    supabaseTokens: { access_token: `a-${token}`, refresh_token: `r-${token}` },
  };
}
function onDisk(s: object): void {
  mockDisk = JSON.stringify({
    encrypted: Buffer.from(`encrypted:${JSON.stringify(s)}`).toString("base64"),
  });
}
function diskSession(): { user: { id: string }; supabaseTokens?: { refresh_token: string } } | null {
  if (!mockDisk) return null;
  const d = Buffer.from(JSON.parse(mockDisk).encrypted, "base64")
    .toString()
    .slice("encrypted:".length);
  return JSON.parse(d);
}
// Pending-user shape: main.ts:849.
const PENDING = { supabaseId: "new-user", email: "new@example.com", displayName: "New", provider: "google" as const };

async function syncUserId(): Promise<unknown> {
  mockEqCalls.length = 0;
  await (mockHandlers.get("sync:get-iphone-last-sync-time") as (...a: unknown[]) => Promise<unknown>)({}, "udid-1");
  return mockEqCalls.find(([k]) => k === "user_id")?.[1];
}
function startSignIn(): void {
  noteSignIn();
  setPendingDeepLinkUser(PENDING);
}

beforeAll(() => {
  require("../../../tests/helpers/installTestSecretStore").installTestSecretStore();
  registerSyncHandlers({ isDestroyed: () => false, webContents: { send: jest.fn() } } as never);
});
beforeEach(() => {
  jest.clearAllMocks();
  getAndClearPendingDeepLinkUser();
  markSignInSessionWritten();
  setSyncUserId(null);
  mockEqCalls.length = 0;
  mockReads = 0;
  mockSdkUserId = "new-user";
  mockWriteFail = false;
  onDisk(sessionFor("old-user", "old@example.com", "old"));
});

describe("BACKLOG-4076: session-file reads while a sign-in awaits its session write", () => {
  it("P1: flag set -> loadSession() is null and session.json is not read", async () => {
    startSignIn();
    expect(await sessionService.loadSession()).toBeNull();
    expect(mockReads).toBe(0);
  });

  it("P2: sync identity is the NEW user in the window and after the write, never the OLD one", async () => {
    startSignIn();
    expect(await syncUserId()).toBe("new-user");
    await saveSignInSession(sessionFor("new-user", "new@example.com", "new"));
    expect(await syncUserId()).toBe("new-user");
  });

  it("P3: a token write-back in the window leaves the OLD file untouched", async () => {
    startSignIn();
    await sessionService.updateSession({ supabaseTokens: { access_token: "a-rot", refresh_token: "r-rot" } });
    const d = diskSession();
    expect(d?.user.id).toBe("old-user");
    expect(d?.supabaseTokens?.refresh_token).toBe("r-old");
  });

  it("P4: a token write-back queued right behind the sign-in write lands on the NEW session", async () => {
    startSignIn();
    const w = saveSignInSession(sessionFor("new-user", "new@example.com", "new"));
    const u = sessionService.updateSession({ supabaseTokens: { access_token: "a-rot", refresh_token: "r-rot" } });
    await Promise.all([w, u]);
    const d = diskSession();
    expect(d?.user.id).toBe("new-user");
    expect(d?.supabaseTokens?.refresh_token).toBe("r-rot");
  });

  it("P5: an idle tick in the window signs nobody out and reports unreadable", async () => {
    startSignIn();
    const r = await enforceSessionIdle({ recordActivity: false });
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSendToMainWindow).not.toHaveBeenCalled();
    expect(r).toBe("unreadable");
  });

  it("K1 keep: no sign-in -> loadSession() returns the file and sync uses its id", async () => {
    expect((await sessionService.loadSession())?.user.id).toBe("old-user");
    mockSdkUserId = null;
    expect(await syncUserId()).toBe("old-user");
  });

  it("K2 keep: the clearing write is not blocked -> saveSignInSession true, flag cleared, NEW readable", async () => {
    startSignIn();
    expect(await saveSignInSession(sessionFor("new-user", "new@example.com", "new"))).toBe(true);
    expect(isSignInAwaitingSessionWrite()).toBe(false);
    expect((await sessionService.loadSession())?.user.id).toBe("new-user");
  });

  it("K3 keep: no sign-in -> an idle-expired session is still signed out", async () => {
    expect(await enforceSessionIdle({ recordActivity: false })).toBe("expired");
    expect(mockSignOut).toHaveBeenCalledWith(expect.objectContaining({ token: "st-old-user", userId: "old-user" }));
  });

  it("K6: a failed sign-in write keeps the flag set; reads stay refused and the OLD file is not read", async () => {
    startSignIn();
    mockWriteFail = true;
    expect(await saveSignInSession(sessionFor("new-user", "new@example.com", "new"))).toBe(false);
    mockWriteFail = false;
    mockReads = 0;
    expect(await sessionService.loadSession()).toBeNull();
    expect(mockReads).toBe(0);
  });
});
