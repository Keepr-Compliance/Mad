/**
 * @jest-environment node
 *
 * BACKLOG-3833 B3: the once-a-minute idle check reads session.json while token
 * rotation may be writing it. The read must never see a half-written file, and
 * an unreadable file must never be deleted or sign anyone out.
 *
 * Real sessionService + real enforcer over an in-memory file system whose
 * writeFile lands in two halves with a pause in between (a torn write).
 */
const files = new Map<string, string>();
let releaseWrite: (() => void) | null = null;
let holdWrites = false;
const mockUnlink = jest.fn(async (p: string) => {
  files.delete(p);
});
jest.mock("fs", () => ({
  promises: {
    readFile: async (p: string) => {
      if (!files.has(p)) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      return files.get(p);
    },
    writeFile: async (p: string, content: string) => {
      files.set(p, content.slice(0, Math.floor(content.length / 2)));
      if (holdWrites) await new Promise<void>((r) => (releaseWrite = r));
      files.set(p, content);
    },
    rename: async (a: string, b: string) => {
      files.set(b, files.get(a) as string);
      files.delete(a);
    },
    unlink: (p: string) => mockUnlink(p),
  },
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: () => true,
    getSessionTimes: (token: string) => {
      mockTokensChecked.push(token);
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);
      return {
        user_id: "user-1",
        created_at: now,
        last_accessed_at: now,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      };
    },
  },
}));
const mockTokensChecked: string[] = [];
const mockSignOut = jest.fn();
jest.mock("../../handlers/sessionSignOut", () => ({
  signOutLocalSession: (...a: unknown[]) => mockSignOut(...a),
}));
const mockSend = jest.fn();
jest.mock("../../windowRegistry", () => ({
  sendToMainWindow: (...a: unknown[]) => mockSend(...a),
}));

import path from "path";
import { app } from "electron";
import sessionService from "../sessionService";
import { enforceSessionIdle } from "../sessionIdleEnforcer";

const SESSION_PATH = path.join(app.getPath("userData"), "session.json");
const tick = () => enforceSessionIdle({ recordActivity: false });
const session = (token: string) => ({
  user: { id: "user-1", email: "a@example.com" },
  sessionToken: token,
  provider: "google",
  expiresAt: Date.now() + 3600_000,
  createdAt: Date.now(),
});
type SaveArg = Parameters<typeof sessionService.saveSession>[0];
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
};

describe("idle check vs session.json writes (BACKLOG-3833)", () => {
  beforeEach(async () => {
    files.clear();
    holdWrites = false;
    releaseWrite = null;
    jest.clearAllMocks();
    mockTokensChecked.length = 0;
    expect(await sessionService.saveSession(session("token-old") as unknown as SaveArg)).toBe(true);
  });

  it("a tick during token rotation waits for the write, reads the new token, signs nobody out", async () => {
    holdWrites = true;
    const saving = sessionService.saveSession(session("token-new") as unknown as SaveArg);
    await until(() => releaseWrite !== null); // write is half done
    const checking = tick();
    await new Promise((r) => setImmediate(r));
    releaseWrite!();
    expect(await saving).toBe(true);
    expect(await checking).toBe("active");
    // queued behind the write: the tick checked the token that was being written
    expect(mockTokensChecked).toEqual(["token-new"]);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    const peek = await sessionService.peekSession();
    expect(peek).toEqual(expect.objectContaining({ status: "ok" }));
    expect(peek.status === "ok" && peek.session.sessionToken).toBe("token-new");
  });

  it("session.json is never half-written: a reader mid-write still sees a whole file", async () => {
    holdWrites = true;
    const saving = sessionService.saveSession(session("token-new") as unknown as SaveArg);
    await until(() => releaseWrite !== null);
    // loadSession is not queued; with a torn write it would delete the file.
    const loaded = await sessionService.loadSession();
    expect(loaded?.sessionToken).toBe("token-old");
    expect(mockUnlink).not.toHaveBeenCalled();
    releaseWrite!();
    expect(await saving).toBe(true);
    expect((await sessionService.loadSession())?.sessionToken).toBe("token-new");
  });

  it("an unreadable session.json: the tick does not sign out and the file is left alone", async () => {
    files.set(SESSION_PATH, '{"encrypted":"trunc');
    expect(await tick()).toBe("unreadable");
    expect(await tick()).toBe("unreadable");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(files.get(SESSION_PATH)).toBe('{"encrypted":"trunc');
  });
});
