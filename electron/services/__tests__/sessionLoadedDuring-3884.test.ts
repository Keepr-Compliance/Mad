/**
 * @jest-environment node
 *
 * BACKLOG-3884 follow-up — "Session loaded successfully" is logged by ten
 * callers. The line now names the IPC channel whose handler started last
 * (`during=`) and how long the file read + decrypt took (`ms=`), so a PC log
 * says which caller logged it. Channel name and ms only.
 */
jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: jest.fn((buf: Buffer) => {
      const str = buf.toString();
      if (str.startsWith("encrypted:")) return str.slice("encrypted:".length);
      throw new Error("Cannot decrypt");
    }),
  },
}));

const mockFs = { writeFile: jest.fn(), rename: jest.fn(), readFile: jest.fn(), unlink: jest.fn() };
jest.mock("fs", () => ({ promises: mockFs }));

const mockLog = {
  info: jest.fn().mockResolvedValue(undefined),
  debug: jest.fn().mockResolvedValue(undefined),
  warn: jest.fn().mockResolvedValue(undefined),
  error: jest.fn().mockResolvedValue(undefined),
};
jest.mock("../logService", () => ({ __esModule: true, default: mockLog, logService: mockLog }));

import { resetIpcActivityForTests, wrapHandleForReplySize, type HandleTarget } from "../ipcReplySize";

function encrypted(sessionData: Record<string, unknown>): string {
  return JSON.stringify({
    encrypted: Buffer.from(`encrypted:${JSON.stringify(sessionData)}`).toString("base64"),
  });
}

const SESSION = {
  user: { id: "user-secret", email: "secret@example.com", oauth_provider: "google", oauth_id: "g-secret" },
  sessionToken: "token-secret",
  provider: "google",
  expiresAt: Date.now() + 3_600_000,
  createdAt: Date.now(),
};

describe("BACKLOG-3884: Session loaded line names the IPC channel it ran under", () => {
  let sessionService: typeof import("../sessionService").default;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetIpcActivityForTests();
    require("../../../tests/helpers/installTestSecretStore").installTestSecretStore();
    mockFs.readFile.mockResolvedValue(encrypted(SESSION));
    sessionService = (await import("../sessionService")).default;
  });

  const loadedLines = () =>
    mockLog.info.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith("Session loaded"));

  it("carries during=<channel> when loaded inside an IPC handler", async () => {
    const registered = new Map<string, (e: unknown) => unknown>();
    const target: HandleTarget = { handle: (c, l) => void registered.set(c, l) };
    wrapHandleForReplySize(target, { phase: () => null, now: () => 0, log: () => {} });
    target.handle("license:get", () => sessionService.loadSession());

    const session = await registered.get("license:get")!({});
    expect(session).not.toBeNull();
    expect(loadedLines()).toEqual([
      expect.stringMatching(/^Session loaded successfully ms=\d+ during=license:get$/),
    ]);
    const all = mockLog.info.mock.calls.map(([m]) => String(m)).join("\n");
    expect(all).not.toContain("secret");
  });

  it("says during=none when no IPC handler has run", async () => {
    await sessionService.loadSession();
    expect(loadedLines()).toEqual([
      expect.stringMatching(/^Session loaded successfully ms=\d+ during=none$/),
    ]);
  });
});
