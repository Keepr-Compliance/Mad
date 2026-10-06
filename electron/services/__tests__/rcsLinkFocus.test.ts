/**
 * @jest-environment node
 */
/**
 * Founder "Option 1" (SR on 667ba1468) — POST /focus on Keepr's side.
 *
 * Mutation controls (each turns a test red):
 *   F1 the link screen opened when no code is waiting (none / locked / answered)
 *   F2 a throwing linkState opening the link screen (or throwing out)
 *   F3 the link screen not opened while a code is waiting
 *   F4 the link raise maximizing (the plain focus used for linking)
 *   F5 a minimized window not coming back at normal bounds
 */

const mockAppFocus = jest.fn();
jest.mock("electron", () => ({ app: { focus: mockAppFocus }, BrowserWindow: jest.fn() }));
jest.mock("../logService", () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import type { BrowserWindow } from "electron";
import { clearLinkCodeFromClipboard, focusForBrowser, linkCodeAutoFillOn, linkCodeFromClipboard } from "../rcsLinkFocus";
import { bringAppToFrontForLink } from "../../utils/bringAppToFront";

function deps(state: () => { state: string }) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      focus: () => calls.push("focus"),
      focusForLink: () => calls.push("focusForLink"),
      linkState: state,
      openLinkScreen: () => calls.push("openLinkScreen"),
    },
  };
}

describe("focusForBrowser", () => {
  it("a code waiting: Keepr raised for linking, the link screen opened (F3)", () => {
    const d = deps(() => ({ state: "waiting" }));
    focusForBrowser(d.deps);
    expect(d.calls).toEqual(["focusForLink", "openLinkScreen"]);
  });

  it("no code waiting: only focused — never the link screen (F1)", () => {
    for (const state of ["none", "locked", "answered", ""]) {
      const d = deps(() => ({ state }));
      focusForBrowser(d.deps);
      expect([state, d.calls]).toEqual([state, ["focus"]]);
    }
  });

  it("a throwing linkState: focused, no link screen, nothing thrown (F2)", () => {
    const d = deps(() => {
      throw new Error("db");
    });
    expect(() => focusForBrowser(d.deps)).not.toThrow();
    expect(d.calls).toEqual(["focus"]);
  });
});

describe("bringAppToFrontForLink", () => {
  function win(opts: { minimized: boolean; maximizedAfterRestore: boolean }) {
    const calls: string[] = [];
    let minimized = opts.minimized;
    let maximized = false;
    const w = {
      calls,
      isDestroyed: () => false,
      isMinimized: () => minimized,
      isMaximized: () => maximized,
      isVisible: () => true,
      isFocused: () => true,
      restore: () => {
        calls.push("restore");
        minimized = false;
        maximized = opts.maximizedAfterRestore;
      },
      unmaximize: () => {
        calls.push("unmaximize");
        maximized = false;
      },
      maximize: () => calls.push("maximize"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
      setAlwaysOnTop: (on: boolean) => calls.push(`top(${String(on)})`),
      moveTop: () => calls.push("moveTop"),
      webContents: { focus: () => calls.push("webContents.focus") },
      flashFrame: () => undefined,
      once: () => undefined,
      get maximized() {
        return maximized;
      },
    };
    return w;
  }

  it("minimized (was maximized): back at normal bounds, never maximized (F4, F5)", () => {
    const w = win({ minimized: true, maximizedAfterRestore: true });
    bringAppToFrontForLink(w as unknown as BrowserWindow);
    expect(w.calls.slice(0, 2)).toEqual(["restore", "unmaximize"]);
    expect(w.calls).not.toContain("maximize");
    expect(w.maximized).toBe(false);
    expect(w.calls).toContain("focus");
  });

  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
  });

  // Live (0.3.57, Windows): raised but typing went nowhere. The full
  // foreground + KEYBOARD focus sequence. Mutations: no always-on-top pair;
  // no moveTop; no webContents.focus; macOS without steal → red.
  it("Windows: show → on-top → focus → off-top → moveTop → page focus", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const w = win({ minimized: false, maximizedAfterRestore: false });
    bringAppToFrontForLink(w as unknown as BrowserWindow);
    expect(w.calls).toEqual(["show", "top(true)", "focus", "top(false)", "moveTop", "webContents.focus"]);
  });

  it("macOS: the app activated with steal, then window + page focus", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockAppFocus.mockClear();
    const w = win({ minimized: false, maximizedAfterRestore: false });
    bringAppToFrontForLink(w as unknown as BrowserWindow);
    expect(mockAppFocus).toHaveBeenCalledWith({ steal: true });
    expect(w.calls).toEqual(["show", "focus", "moveTop", "webContents.focus"]);
  });

  it("visible: raised as it is (its size untouched)", () => {
    const w = win({ minimized: false, maximizedAfterRestore: false });
    bringAppToFrontForLink(w as unknown as BrowserWindow);
    expect(w.calls).not.toContain("unmaximize");
    expect(w.calls).not.toContain("maximize");
    expect(w.calls).toContain("focus");
  });
});

// Founder (2026-10-06): keepr://link fills the link box with the code
// "Copy code and open Keepr" copied — Windows only, while a link is waiting,
// exactly the code. Mutations (each red): not Windows-only; read with no link
// waiting; any digits accepted (5 / 7 / text); the clipboard read when the
// gate already says no.
describe("linkCodeFromClipboard (keepr://link, Windows)", () => {
  const read = jest.fn(() => "123456");
  const waiting = () => ({ state: "waiting" });
  beforeEach(() => read.mockClear());

  it("Windows + a link waiting + exactly the code → the 6 digits (spaced as shown, too)", () => {
    expect(linkCodeFromClipboard({ platform: "win32", linkState: waiting, readClipboard: read })).toBe("123456");
    read.mockReturnValueOnce("123 456");
    expect(linkCodeFromClipboard({ platform: "win32", linkState: waiting, readClipboard: read })).toBe("123456");
    read.mockReturnValueOnce(" 042137\r\n");
    expect(linkCodeFromClipboard({ platform: "win32", linkState: waiting, readClipboard: read })).toBe("042137");
  });

  it("anything but the code is ignored", () => {
    for (const text of ["12345", "1234567", "12 3456", "123  456", "abcdef", "123-456", "code 123456", ""]) {
      read.mockReturnValueOnce(text);
      expect(linkCodeFromClipboard({ platform: "win32", linkState: waiting, readClipboard: read })).toBeNull();
    }
  });

  it("Mac / Linux, or no link waiting (stale): the clipboard is never read", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(linkCodeFromClipboard({ platform, linkState: waiting, readClipboard: read })).toBeNull();
    }
    for (const state of ["none", "answered", "locked"]) {
      expect(linkCodeFromClipboard({ platform: "win32", linkState: () => ({ state }), readClipboard: read })).toBeNull();
    }
    expect(linkCodeFromClipboard({ platform: "win32", linkState: () => { throw new Error("x"); }, readClipboard: read })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("a clipboard that cannot be read: null, never a throw", () => {
    expect(linkCodeFromClipboard({ platform: "win32", linkState: waiting, readClipboard: () => { throw new Error("busy"); } })).toBeNull();
  });

  it("the deep link logs whether a code came, never the code itself", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const main = (require("fs") as typeof import("fs")).readFileSync(require("path").join(__dirname, "..", "..", "main.ts"), "utf8");
    const at = main.indexOf("if (isRcsLinkDeepLink(url)) {");
    const branch = main.slice(at, main.indexOf("return;", at));
    expect(branch).toContain('log.info("[DeepLink] Link screen requested", { codeFromClipboard: code !== null });');
    // The one log call in the branch is that one: a boolean, never the value.
    expect(branch.match(/log\.[a-z]+\(/g)).toHaveLength(1);
  });
});

// Founder (2026-10-06): the accepted code leaves the clipboard — Windows
// only, and only if the clipboard still holds THAT code. Mutations (each
// red): cleared when it changed; cleared off Windows; cleared without
// comparing.
describe("clearLinkCodeFromClipboard (after the code is accepted)", () => {
  const clear = jest.fn();
  beforeEach(() => clear.mockClear());

  it("Windows, the same code still there (as shown, too): cleared", () => {
    expect(clearLinkCodeFromClipboard({ platform: "win32", code: "123456", readClipboard: () => "123456", clearClipboard: clear })).toBe(true);
    expect(clearLinkCodeFromClipboard({ platform: "win32", code: "123456", readClipboard: () => "123 456", clearClipboard: clear })).toBe(true);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("the user copied something else since (another code, text): left as it is", () => {
    for (const text of ["654321", "an address", "", "1234567"]) {
      expect(clearLinkCodeFromClipboard({ platform: "win32", code: "123456", readClipboard: () => text, clearClipboard: clear })).toBe(false);
    }
    expect(clear).not.toHaveBeenCalled();
  });

  it("not Windows, or no valid code: never touched; a read that fails: nothing", () => {
    for (const platform of ["darwin", "linux"]) {
      expect(clearLinkCodeFromClipboard({ platform, code: "123456", readClipboard: () => "123456", clearClipboard: clear })).toBe(false);
    }
    expect(clearLinkCodeFromClipboard({ platform: "win32", code: "", readClipboard: () => "", clearClipboard: clear })).toBe(false);
    expect(clearLinkCodeFromClipboard({ platform: "win32", code: "123456", readClipboard: () => { throw new Error("busy"); }, clearClipboard: clear })).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });

  it("only after an accepted code: the handler clears inside the success branch", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require("fs") as typeof import("fs")).readFileSync(require("path").join(__dirname, "..", "..", "handlers", "rcsImportHandlers.ts"), "utf8");
    const at = src.indexOf('"rcs-import:link-enter-code"');
    const handler = src.slice(at, src.indexOf("{ module: LOG_TAG }", at));
    const ok = handler.indexOf("if (r.ok) {");
    expect(ok).toBeGreaterThan(0);
    expect(handler.indexOf("clearLinkCodeFromClipboard(")).toBeGreaterThan(ok);
    expect(handler.indexOf("clearLinkCodeFromClipboard(")).toBeLessThan(handler.indexOf("return { success: true };"));
    expect(handler.match(/clearLinkCodeFromClipboard\(/g)).toHaveLength(1);
  });
});

// Founder: ONE platform rule for the fill, the clear and the link screen's
// copy. Mutation: a second platform let in → red.
describe("linkCodeAutoFillOn", () => {
  it("Windows only", () => {
    expect(linkCodeAutoFillOn("win32")).toBe(true);
    for (const p of ["darwin", "linux", "freebsd"]) expect(linkCodeAutoFillOn(p)).toBe(false);
  });
});
