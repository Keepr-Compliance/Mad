/**
 * BACKLOG-3833: a handler registered through handleBusy keeps the session
 * from going idle while its promise is pending, and the idle clock restarts
 * when it settles.
 */
const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
jest.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, fn: (...args: unknown[]) => unknown) => mockHandlers.set(ch, fn),
  },
}));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

import { handleBusy } from "../busyIpc";
import sessionSecurityService from "../../services/sessionSecurityService";

const MIN = 60 * 1000;
const T0 = Date.parse("2026-10-08T12:00:00Z");
const TOKEN = "tok";
const session = { created_at: new Date(T0).toISOString().replace("T", " ").slice(0, 19) };
const check = () => sessionSecurityService.checkSessionValidity(session, TOKEN);

describe("handleBusy (BACKLOG-3833)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    sessionSecurityService.clearAllActivity();
    mockHandlers.clear();
  });
  afterEach(() => jest.useRealTimers());

  it("pending handler = not idle; idle runs 30 min from when it settles", async () => {
    let finish!: (v: string) => void;
    const handler = jest.fn(
      (_e: unknown, arg: string) => new Promise<string>((r) => (finish = (v) => r(`${arg}:${v}`))),
    );
    handleBusy("test:long-op", handler);
    await check(); // tracking starts

    const result = mockHandlers.get("test:long-op")!({}, "a");
    jest.setSystemTime(T0 + 40 * MIN);
    expect((await check()).valid).toBe(true);

    finish("done");
    await expect(result).resolves.toBe("a:done");
    jest.setSystemTime(T0 + 40 * MIN + 29 * MIN);
    expect((await check()).valid).toBe(true);
    jest.setSystemTime(T0 + 40 * MIN + 31 * MIN);
    expect(await check()).toEqual({ valid: false, reason: "idle" });
  });
});
