/**
 * @jest-environment node
 */

/**
 * BACKLOG-4075: updateSession's `proceed` runs INSIDE the session.json lock,
 * against the record on disk at write time. A sign-in write queued ahead of a
 * token write-back has already replaced the file when the guard is asked.
 * Real sessionService; fs is an in-memory session.json (sessionFileState-4076 harness).
 */

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
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

let mockDisk: string | null = null;
let mockTmp: string | null = null;
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: jest.fn(async (p: string, ...rest: unknown[]) => {
        if (String(p).endsWith("session.json")) {
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
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("../logService", () => ({ __esModule: true, default: mockLog, logService: mockLog }));
jest.mock("@sentry/electron/main", () => ({ captureMessage: jest.fn(), captureException: jest.fn(), addBreadcrumb: jest.fn() }));

import sessionService from "../sessionService";

function sessionFor(id: string, token: string) {
  return {
    user: { id, email: `${id}@example.test` } as never,
    sessionToken: `st-${id}`,
    provider: "google" as const,
    expiresAt: Date.now() + 86_400_000,
    createdAt: Date.now(),
    supabaseTokens: { access_token: `a-${token}`, refresh_token: `r-${token}` },
  };
}
function disk(): { user: { id: string }; supabaseTokens?: { refresh_token: string } } {
  const wrapped = JSON.parse(mockDisk!) as { encrypted: string };
  return JSON.parse(Buffer.from(wrapped.encrypted, "base64").toString().slice(10));
}
const rotatedTokens = { supabaseTokens: { access_token: "a-rot", refresh_token: "r-rot" } };
const onlyFor = (id: string) => ({ proceed: (cur: { user: { id: string } }) => cur.user.id === id });

beforeEach(async () => {
  jest.clearAllMocks();
  mockDisk = null;
  await sessionService.saveSession(sessionFor("acct-a", "a"));
});

describe("BACKLOG-4075: updateSession proceed runs inside the lock", () => {
  it("L1 proceed true: written", async () => {
    expect(await sessionService.updateSession(rotatedTokens, onlyFor("acct-a"))).toBe(true);
    expect(disk().supabaseTokens?.refresh_token).toBe("r-rot");
  });

  it("L2 proceed false: nothing written, file unchanged", async () => {
    expect(await sessionService.updateSession(rotatedTokens, onlyFor("acct-x"))).toBe(false);
    expect(disk().user.id).toBe("acct-a");
    expect(disk().supabaseTokens?.refresh_token).toBe("r-a");
  });

  it("L3 a sign-in write queued AHEAD: the guard sees B's file and A's rotation is not written into it", async () => {
    const save = sessionService.saveSession(sessionFor("acct-b", "b"));
    const upd = sessionService.updateSession(rotatedTokens, onlyFor("acct-a"));
    const [, wrote] = await Promise.all([save, upd]);
    expect(wrote).toBe(false);
    expect(disk().user.id).toBe("acct-b");
    expect(disk().supabaseTokens?.refresh_token).toBe("r-b");
  });

  it("L4 no proceed: unchanged behaviour (preAuthValidation, preferencesMirror callers)", async () => {
    expect(await sessionService.updateSession(rotatedTokens)).toBe(true);
    expect(disk().supabaseTokens?.refresh_token).toBe("r-rot");
  });
});
