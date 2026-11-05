/**
 * @jest-environment node
 */
/* BACKLOG-3322: silent retry of the sign-in session-file write. Mocked sessionService, 3555 style. */
import { readFileSync } from "fs";
import path from "path";

const mockSave = jest.fn();
jest.mock("../sessionService", () => ({ __esModule: true, default: { saveSession: (...a: unknown[]) => mockSave(...a) } }));
const mockAuth = jest.fn();
jest.mock("../supabaseService", () => ({ __esModule: true, default: { getAuthSession: (...a: unknown[]) => mockAuth(...a) } }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("../logService", () => ({ __esModule: true, default: mockLog }));
const mockCapture = jest.fn();
jest.mock("@sentry/electron/main", () => ({ captureMessage: (...a: unknown[]) => mockCapture(...a), captureException: jest.fn() }));

import * as st from "../signInState";
import { noteSessionClearRequested } from "../sessionFileState";

// Shape transcribed from main.ts saveSignInSession call (:770-783).
const DATA = {
  user: { id: "u1", email: "a@example.test" }, sessionToken: "tok", provider: "google",
  subscription: { tier: "free", status: "trial", isActive: true, isTrial: true, trialEnded: false, trialDaysRemaining: 0 },
  expiresAt: 1, createdAt: 1, supabaseTokens: { access_token: "a0", refresh_token: "r0" },
} as never;
// getAuthSession() shape: supabaseService.ts:386-392.
const tokens = (n: number) => ({ userId: "u1", accessToken: `a${n}`, refreshToken: `r${n}` });

// Emulates saveSession's in-lock proceed check (sessionService.ts saveSession).
const saveReturning = (...results: boolean[]) => {
  let i = 0;
  mockSave.mockImplementation(async (_d: unknown, o: { proceed?: () => boolean }) => {
    if (o?.proceed && !o.proceed()) return false;
    const r = results[Math.min(i, results.length - 1)]; i += 1; return r;
  });
};
/** Let the loop run: flush microtasks, then fire the next timer. */
async function drive(ms: number) { await jest.advanceTimersByTimeAsync(ms); }

beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); mockSave.mockReset(); mockAuth.mockReset(); st.getAndClearPendingDeepLinkUser(); st.markSignInSessionWritten(); });
afterEach(() => { st.markSignInSessionWritten(); jest.useRealTimers(); });

it("R1 first write false -> retry -> second write true: resolves true, flag cleared, success-on-retry logged once, no give-up", async () => {
  saveReturning(false, true); mockAuth.mockResolvedValue(tokens(1));
  const p = st.saveSignInSession(DATA);
  await drive(600);
  await expect(p).resolves.toBe(true);
  expect(mockSave).toHaveBeenCalledTimes(2);
  expect(st.isSignInAwaitingSessionWrite()).toBe(false);
  expect(mockLog.info.mock.calls.filter((c) => c[0] === "Sign-in session written on retry")).toHaveLength(1);
  expect(mockLog.error).not.toHaveBeenCalled();
  expect(mockCapture).not.toHaveBeenCalled();
});

it("R2 every write false -> exactly 1 + 3 attempts, then stop", async () => {
  saveReturning(false); mockAuth.mockResolvedValue(tokens(1));
  const p = st.saveSignInSession(DATA);
  await drive(10_000);
  await expect(p).resolves.toBe(false);
  expect(mockSave).toHaveBeenCalledTimes(1 + st.SIGN_IN_WRITE_RETRY_DELAYS_MS.length);
  expect(st.SIGN_IN_WRITE_RETRY_DELAYS_MS).toEqual([500, 1000, 2000]);
  await drive(120_000);
  expect(mockSave).toHaveBeenCalledTimes(4);
});

it("R3 backoff: gaps of 500, 1000, 2000 ms between the 4 attempts; every wait timer is unref'd", async () => {
  const at: number[] = []; const t0 = Date.now();
  saveReturning(false); mockSave.mockImplementation(async () => { at.push(Date.now() - t0); return false; });
  mockAuth.mockResolvedValue(tokens(1));
  const real = global.setTimeout; const unrefs: number[] = [];
  const spy = jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    const h = (real as unknown as (f: () => void, m?: number) => NodeJS.Timeout)(fn, ms);
    const u = h.unref.bind(h); (h as { unref: () => NodeJS.Timeout }).unref = () => { unrefs.push(ms ?? 0); return u(); };
    return h;
  }) as never);
  const p = st.saveSignInSession(DATA);
  await drive(5000); await p; spy.mockRestore();
  const gaps = at.slice(1).map((v, i) => v - at[i]);
  expect(at).toHaveLength(4);
  expect(gaps).toEqual([500, 1000, 2000]);
  expect(unrefs.filter((m) => m !== st.SIGN_IN_WRITE_OVERDUE_MS).sort((a, b) => a - b)).toEqual([500, 1000, 2000]);
});

it("R4 each retry carries the SDK's current tokens (rotated between attempts)", async () => {
  saveReturning(false, false, true); mockAuth.mockResolvedValueOnce(tokens(1)).mockResolvedValueOnce(tokens(2));
  const p = st.saveSignInSession(DATA); await drive(2000); await expect(p).resolves.toBe(true);
  expect(mockSave.mock.calls.map((c) => c[0].supabaseTokens.refresh_token)).toEqual(["r0", "r1", "r2"]);
  expect(mockSave.mock.calls[2][0].sessionToken).toBe("tok");
});

it("R5 every attempt fails -> flag stays set, ONE error log + ONE Sentry event from signInState, no success line, no later overdue alarm", async () => {
  saveReturning(false); mockAuth.mockResolvedValue(tokens(1));
  const p = st.saveSignInSession(DATA); await drive(5000); await expect(p).resolves.toBe(false);
  expect(st.isSignInAwaitingSessionWrite()).toBe(true);
  expect(mockLog.error).toHaveBeenCalledTimes(1);
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(mockCapture).toHaveBeenCalledWith("Sign-in session write failed after retries", expect.objectContaining({ level: "error", tags: { component: "signInState" } }));
  expect(mockLog.info.mock.calls.filter((c) => /written on retry/.test(c[0]))).toHaveLength(0);
  jest.advanceTimersByTime(10 * st.SIGN_IN_WRITE_OVERDUE_MS);
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(st.isSignInAwaitingSessionWrite()).toBe(true);
});

it("R6a sign-out (a clearSession request) during the retry window -> no further attempt", async () => {
  saveReturning(false, true); mockAuth.mockResolvedValue(tokens(1));
  const p = st.saveSignInSession(DATA); await drive(100);
  noteSessionClearRequested();
  await drive(5000); await expect(p).resolves.toBe(false);
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(mockCapture).not.toHaveBeenCalled();
});

it("R6b a newer sign-in during the retry window -> the old retry stops", async () => {
  saveReturning(false, true); mockAuth.mockResolvedValue(tokens(1));
  const p = st.saveSignInSession(DATA); await drive(100);
  st.noteSignIn();
  await drive(5000); await expect(p).resolves.toBe(false);
  expect(mockSave).toHaveBeenCalledTimes(1);
});

it("R6c SDK signed out (no tokens) -> the retry stops without writing", async () => {
  saveReturning(false, true); mockAuth.mockResolvedValue(null);
  const p = st.saveSignInSession(DATA); await drive(5000); await expect(p).resolves.toBe(false);
  expect(mockSave).toHaveBeenCalledTimes(1);
});

it("R7 the whole retry schedule fits inside LicenseContext's bounded re-ask (no new IPC needed)", () => {
  const src = readFileSync(path.join(__dirname, "../../../src/contexts/LicenseContext.tsx"), "utf8");
  const ms = Number(/SESSION_WAIT_RETRY_MS = (\d+)/.exec(src)![1]);
  const n = Number(/SESSION_WAIT_MAX_RETRIES = (\d+)/.exec(src)![1]);
  const total = st.SIGN_IN_WRITE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  expect(total).toBeLessThan(ms * n);
});

it("U7m Branch A (no pending user): first failure sets the flag", async () => {
  saveReturning(false, true); mockAuth.mockResolvedValue(tokens(1));
  expect(st.isSignInAwaitingSessionWrite()).toBe(false);
  const p = st.saveSignInSession(DATA); await drive(100);
  expect(st.isSignInAwaitingSessionWrite()).toBe(true);
  await drive(1000); await p;
});

it("M6e Branch A: first failure arms the overdue alarm; a hung retry is reported once at 60 s", async () => {
  let n = 0; mockSave.mockImplementation(() => (n++ === 0 ? Promise.resolve(false) : new Promise(() => undefined)));
  mockAuth.mockResolvedValue(tokens(1));
  void st.saveSignInSession(DATA); await drive(1000);
  jest.advanceTimersByTime(st.SIGN_IN_WRITE_OVERDUE_MS - 1100);
  expect(mockCapture).not.toHaveBeenCalled();
  jest.advanceTimersByTime(200);
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(mockCapture).toHaveBeenCalledWith("Sign-in session write overdue", expect.anything());
  jest.advanceTimersByTime(10 * st.SIGN_IN_WRITE_OVERDUE_MS);
  expect(mockCapture).toHaveBeenCalledTimes(1);
});

it("M6f a successful retry disarms the alarm (nothing reported at 60 s)", async () => {
  saveReturning(false, true); mockAuth.mockResolvedValue(tokens(1));
  const p = st.saveSignInSession(DATA); await drive(1000); await p;
  jest.advanceTimersByTime(10 * st.SIGN_IN_WRITE_OVERDUE_MS);
  expect(mockCapture).not.toHaveBeenCalled();
});

it("M6g Branch B: the alarm keeps the deadline set when the pending user was stored, not when a write later failed", async () => {
  st.setPendingDeepLinkUser({ supabaseId: "u1", email: "a@example.test", provider: "google" });
  await drive(30_000);
  let n = 0; mockSave.mockImplementation(() => (n++ === 0 ? Promise.resolve(false) : new Promise(() => undefined)));
  mockAuth.mockResolvedValue(tokens(1));
  void st.saveSignInSession(DATA); await drive(1000);
  jest.advanceTimersByTime(st.SIGN_IN_WRITE_OVERDUE_MS - 31_000);
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(mockCapture).toHaveBeenCalledWith("Sign-in session write overdue", expect.objectContaining({ extra: { waitedMs: st.SIGN_IN_WRITE_OVERDUE_MS } }));
});
