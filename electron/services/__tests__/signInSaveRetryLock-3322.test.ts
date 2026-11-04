/**
 * @jest-environment node
 */
/* BACKLOG-3322: sign-in write retry against the REAL session write lock. Real sessionService + signInState + sessionFileState; fs/electron/SDK mocked (4076 harness). */
jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn(), on: jest.fn(), removeAllListeners: jest.fn() },
  BrowserWindow: jest.fn(),
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: jest.fn((buf: Buffer) => { const s = buf.toString(); if (s.startsWith("encrypted:")) return s.slice(10); throw new Error("not encrypted"); }),
  },
}));
let mockDisk: string | null = null; let mockTmp: string | null = null; let mockReads = 0; let mockWriteFail = false; let mockWrites = 0;
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return { ...actual, promises: { ...actual.promises,
    readFile: jest.fn(async (p: string, ...rest: unknown[]) => {
      if (String(p).endsWith("session.json")) { mockReads += 1; if (mockDisk === null) { const e = new Error("ENOENT") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; } return mockDisk; }
      return actual.promises.readFile(p, ...rest);
    }),
    writeFile: jest.fn(async (p: string, c: string) => { if (mockWriteFail) throw new Error("EIO"); mockWrites += 1; if (String(p).endsWith("session.json.tmp")) mockTmp = c; }),
    rename: jest.fn(async () => { mockDisk = mockTmp; }),
    unlink: jest.fn(async (p: string) => { if (String(p).endsWith("session.json")) mockDisk = null; }),
    mkdir: jest.fn(async () => undefined),
  } };
});
const mockLog = { info: jest.fn().mockResolvedValue(undefined), warn: jest.fn().mockResolvedValue(undefined), error: jest.fn().mockResolvedValue(undefined), debug: jest.fn().mockResolvedValue(undefined) };
jest.mock("../logService", () => ({ __esModule: true, default: mockLog, logService: mockLog }));
jest.mock("@sentry/electron/main", () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn(), setUser: jest.fn() }));
const mockAuth = jest.fn();
jest.mock("../supabaseService", () => ({ __esModule: true, default: { getAuthSession: (...a: unknown[]) => mockAuth(...a) } }));

import sessionService from "../sessionService";
import { getAndClearPendingDeepLinkUser, isSignInAwaitingSessionWrite, markSignInSessionWritten, noteSignIn, saveSignInSession } from "../signInState";

// Session shape: systemHandlers.ts persistSessionForUser (:225-243).
function sessionFor(id: string, token: string) {
  return { user: { id, email: `${id}@example.com` } as never, sessionToken: `st-${id}`, provider: "google" as const,
    subscription: { tier: "free", status: "trial", isActive: true, isTrial: true, trialEnded: false, trialDaysRemaining: 0 } as never,
    expiresAt: Date.now() + 86_400_000, createdAt: Date.now(), supabaseTokens: { access_token: `a-${token}`, refresh_token: `r-${token}` } };
}
function onDisk(s: object): void { mockDisk = JSON.stringify({ encrypted: Buffer.from(`encrypted:${JSON.stringify(s)}`).toString("base64") }); }
function diskUser(): string | null { if (!mockDisk) return null; return JSON.parse(Buffer.from(JSON.parse(mockDisk).encrypted, "base64").toString().slice(10)).user.id; }

beforeAll(() => { require("../../../tests/helpers/installTestSecretStore").installTestSecretStore(); });
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); getAndClearPendingDeepLinkUser(); markSignInSessionWritten();
  mockReads = 0; mockWrites = 0; mockWriteFail = false; onDisk(sessionFor("old-user", "old"));
  mockAuth.mockResolvedValue({ userId: "new-user", accessToken: "a-new2", refreshToken: "r-new2" });
});
afterEach(() => { markSignInSessionWritten(); jest.useRealTimers(); });

it("U7 Branch A (flag unset, no pending user): a failed write refuses reads during the retry window; the OLD file is not read", async () => {
  noteSignIn(); mockWriteFail = true;
  const p = saveSignInSession(sessionFor("new-user", "new"));
  await jest.advanceTimersByTimeAsync(100);
  expect(isSignInAwaitingSessionWrite()).toBe(true);
  mockReads = 0;
  expect(await sessionService.loadSession()).toBeNull();
  expect(mockReads).toBe(0);
  await jest.advanceTimersByTimeAsync(10_000); await expect(p).resolves.toBe(false);
  expect(await sessionService.loadSession()).toBeNull();
});

it("R1r a transient failure heals on retry: NEW user on disk with the SDK's current tokens, reads allowed", async () => {
  noteSignIn(); mockWriteFail = true;
  const p = saveSignInSession(sessionFor("new-user", "new"));
  await jest.advanceTimersByTimeAsync(100); mockWriteFail = false;
  await jest.advanceTimersByTimeAsync(1000); await expect(p).resolves.toBe(true);
  expect(diskUser()).toBe("new-user");
  expect((await sessionService.loadSession())?.supabaseTokens?.refresh_token).toBe("r-new2");
});

it("R6 sign-out while the retry waits: clearSession removes the file and no retry writes it back", async () => {
  noteSignIn(); mockWriteFail = true;
  const p = saveSignInSession(sessionFor("new-user", "new"));
  await jest.advanceTimersByTimeAsync(100); mockWriteFail = false;
  await sessionService.clearSession();
  await jest.advanceTimersByTimeAsync(10_000); await expect(p).resolves.toBe(false);
  expect(mockDisk).toBeNull(); expect(mockWrites).toBe(0);
});

it("R6L sign-out lands while the retry reads tokens (after its pre-check, before it queues): the in-lock check refuses the write", async () => {
  noteSignIn(); mockWriteFail = true;
  mockAuth.mockImplementation(async () => { void sessionService.clearSession(); return { userId: "new-user", accessToken: "a-new2", refreshToken: "r-new2" }; });
  const p = saveSignInSession(sessionFor("new-user", "new"));
  await jest.advanceTimersByTimeAsync(100); mockWriteFail = false;
  await jest.advanceTimersByTimeAsync(10_000); await expect(p).resolves.toBe(false);
  expect(mockDisk).toBeNull(); expect(mockWrites).toBe(0);
});

it("SR-R1W a token write-back queued behind a SUCCESSFUL retry lands on the new file", async () => {
  const fsMock = require("fs");
  noteSignIn(); mockWriteFail = true;
  const p = saveSignInSession(sessionFor("new-user", "new"));
  await jest.advanceTimersByTimeAsync(100); mockWriteFail = false;
  fsMock.promises.rename.mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, 50)); mockDisk = mockTmp; });
  await jest.advanceTimersByTimeAsync(401);
  const u = sessionService.updateSession({ supabaseTokens: { access_token: "a-rot", refresh_token: "r-rot" } });
  await jest.advanceTimersByTimeAsync(200);
  await expect(p).resolves.toBe(true);
  await expect(u).resolves.toBe(true);
  expect((await sessionService.loadSession())?.supabaseTokens?.refresh_token).toBe("r-rot");
});
