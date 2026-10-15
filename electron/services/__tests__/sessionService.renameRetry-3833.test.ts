/**
 * @jest-environment node
 *
 * BACKLOG-3833: session.json is written as a temp file then renamed over the
 * target. On Windows the rename can fail transiently (scanner lock). It is
 * retried; if it still fails the existing session stays and no temp is left.
 */
const files = new Map<string, string>();
let renameFailures: { code: string; remaining: number } | null = null;
const mockRename = jest.fn(async (a: string, b: string) => {
  if (renameFailures && renameFailures.remaining > 0) {
    renameFailures.remaining--;
    const e = new Error(renameFailures.code) as NodeJS.ErrnoException;
    e.code = renameFailures.code;
    throw e;
  }
  files.set(b, files.get(a) as string);
  files.delete(a);
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
      files.set(p, content);
    },
    rename: (a: string, b: string) => mockRename(a, b),
    unlink: async (p: string) => {
      if (!files.has(p)) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
      files.delete(p);
    },
  },
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import path from "path";
import { app } from "electron";
import sessionService from "../sessionService";

const SESSION_PATH = path.join(app.getPath("userData"), "session.json");
const TMP_PATH = `${SESSION_PATH}.tmp`;
const session = (token: string) => ({
  user: { id: "user-1", email: "a@example.com" },
  sessionToken: token,
  provider: "google",
  expiresAt: Date.now() + 3600_000,
  createdAt: Date.now(),
});
type SaveArg = Parameters<typeof sessionService.saveSession>[0];

describe("session.json temp+rename (BACKLOG-3833)", () => {
  beforeEach(async () => {
    files.clear();
    renameFailures = null;
    jest.clearAllMocks();
    expect(await sessionService.saveSession(session("token-old") as unknown as SaveArg)).toBe(true);
    mockRename.mockClear();
  });

  it.each([["EPERM"], ["EBUSY"]])("%s twice then success: the session is saved", async (code) => {
    renameFailures = { code, remaining: 2 };
    expect(await sessionService.saveSession(session("token-new") as unknown as SaveArg)).toBe(true);
    expect(mockRename).toHaveBeenCalledTimes(3);
    expect(files.has(TMP_PATH)).toBe(false);
    expect((await sessionService.loadSession())?.sessionToken).toBe("token-new");
  });

  it("persistent failure: old session intact, no .tmp left, save reports false", async () => {
    renameFailures = { code: "EPERM", remaining: 1000 };
    expect(await sessionService.saveSession(session("token-new") as unknown as SaveArg)).toBe(false);
    expect(mockRename.mock.calls.length).toBeGreaterThan(1);
    expect(files.has(TMP_PATH)).toBe(false);
    renameFailures = null;
    expect((await sessionService.loadSession())?.sessionToken).toBe("token-old");
  });

  it("clearSession removes session.json.tmp as well as session.json", async () => {
    files.set(TMP_PATH, "sealed-leftover");
    expect(await sessionService.clearSession()).toBe(true);
    expect(files.has(TMP_PATH)).toBe(false);
    expect(files.has(SESSION_PATH)).toBe(false);
  });
});
