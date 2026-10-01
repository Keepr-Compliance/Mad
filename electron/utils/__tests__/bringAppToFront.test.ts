/**
 * @jest-environment node
 */
/**
 * BACKLOG-3636 — bringAppToFront on each platform.
 *
 * Windows: the foreground lock turns a background `focus()` into a taskbar
 * flash, so the window is made always-on-top, shown, focused, and the flag is
 * cleared again — ALWAYS, even when show/focus throws.
 * macOS (and Linux): unchanged from BACKLOG-3394 — no always-on-top.
 *
 * Mutations that turn this suite red:
 *   - drop the win32 branch (plain focus on Windows) → the order test fails;
 *   - move `setAlwaysOnTop(false)` out of the `finally` → the throw test fails
 *     (the window would stay pinned above every other window);
 *   - call the Windows step on every platform → the macOS test fails.
 */

const mockAppFocus = jest.fn();
const mockWarn = jest.fn();

jest.mock("electron", () => ({
  app: { focus: mockAppFocus },
  BrowserWindow: jest.fn(),
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { warn: mockWarn, info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { BrowserWindow } from "electron";
import { bringAppToFront, bringAppToFrontOrFlash } from "../bringAppToFront";

type FakeWindow = {
  calls: string[];
  isDestroyed: jest.Mock;
  isMinimized: jest.Mock;
  isVisible: jest.Mock;
  restore: jest.Mock;
  show: jest.Mock;
  focus: jest.Mock;
  setAlwaysOnTop: jest.Mock;
};

function fakeWindow(opts: { minimized?: boolean; visible?: boolean } = {}): FakeWindow {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: jest.fn().mockReturnValue(false),
    isMinimized: jest.fn().mockReturnValue(opts.minimized ?? false),
    isVisible: jest.fn().mockReturnValue(opts.visible ?? true),
    restore: jest.fn(() => calls.push("restore")),
    show: jest.fn(() => calls.push("show")),
    focus: jest.fn(() => calls.push("focus")),
    setAlwaysOnTop: jest.fn((flag: boolean) => calls.push(`top(${String(flag)})`)),
  };
}

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
  jest.clearAllMocks();
});

const asWindow = (w: FakeWindow): BrowserWindow => w as unknown as BrowserWindow;

describe("bringAppToFront — Windows (BACKLOG-3636)", () => {
  beforeEach(() => onPlatform("win32"));

  it("always-on-top → show → focus → always-on-top off, in that order", () => {
    const win = fakeWindow();
    bringAppToFront(asWindow(win));
    expect(win.calls).toEqual(["top(true)", "show", "focus", "top(false)"]);
    expect(mockAppFocus).toHaveBeenCalledWith({ steal: true });
  });

  it("restores a minimised window first", () => {
    const win = fakeWindow({ minimized: true });
    bringAppToFront(asWindow(win));
    expect(win.calls).toEqual(["restore", "top(true)", "show", "focus", "top(false)"]);
  });

  it("when focus throws, always-on-top is still cleared and nothing is rethrown", () => {
    const win = fakeWindow();
    win.focus.mockImplementation(() => {
      win.calls.push("focus");
      throw new Error("focus failed");
    });
    expect(() => bringAppToFront(asWindow(win))).not.toThrow();
    expect(win.calls).toEqual(["top(true)", "show", "focus", "top(false)"]);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("a destroyed window or no window: only the app is activated", () => {
    const win = fakeWindow();
    win.isDestroyed.mockReturnValue(true);
    bringAppToFront(asWindow(win));
    bringAppToFront(null);
    expect(win.calls).toEqual([]);
    expect(mockAppFocus).toHaveBeenCalledTimes(2);
  });
});

describe("bringAppToFront — macOS unchanged", () => {
  beforeEach(() => onPlatform("darwin"));

  it("steal-focuses the app and focuses the window, never always-on-top", () => {
    const win = fakeWindow({ minimized: true });
    bringAppToFront(asWindow(win));
    expect(mockAppFocus).toHaveBeenCalledWith({ steal: true });
    expect(win.calls).toEqual(["restore", "focus"]);
    expect(win.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("shows a hidden window before focusing it", () => {
    const win = fakeWindow({ visible: false });
    bringAppToFront(asWindow(win));
    expect(win.calls).toEqual(["show", "focus"]);
  });
});

// BACKLOG-3641: "Open Keepr" from the browser. Mutation: no flash fallback, or
// flashing when the window did come to the front → red.
describe("bringAppToFrontOrFlash — the page's Open Keepr", () => {
  beforeEach(() => onPlatform("win32"));

  function flashWindow(focusedAfter: boolean) {
    const win = fakeWindow();
    const extra = {
      isFocused: jest.fn().mockReturnValue(focusedAfter),
      flashFrame: jest.fn((on: boolean) => win.calls.push(`flash(${String(on)})`)),
      once: jest.fn((event: string, cb: () => void) => {
        win.calls.push(`once(${event})`);
        (extra as { focusCb?: () => void }).focusCb = cb;
      }),
    };
    return { win: Object.assign(win, extra), extra: extra as typeof extra & { focusCb?: () => void } };
  }

  it("Windows refused the foreground change: the taskbar button flashes until Keepr gets focus", () => {
    const { win, extra } = flashWindow(false);
    bringAppToFrontOrFlash(win as unknown as BrowserWindow);
    expect(win.calls).toEqual(["top(true)", "show", "focus", "top(false)", "flash(true)", "once(focus)"]);
    extra.focusCb?.();
    expect(win.calls[win.calls.length - 1]).toBe("flash(false)");
  });

  it("Keepr came to the front: no flash", () => {
    const { win } = flashWindow(true);
    bringAppToFrontOrFlash(win as unknown as BrowserWindow);
    expect(win.calls).toEqual(["top(true)", "show", "focus", "top(false)"]);
  });

  it("no window: nothing to flash, no throw", () => {
    expect(() => bringAppToFrontOrFlash(null)).not.toThrow();
  });
});
