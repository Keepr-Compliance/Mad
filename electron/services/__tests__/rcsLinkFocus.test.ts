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
import { focusForBrowser } from "../rcsLinkFocus";
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
      setAlwaysOnTop: () => undefined,
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

  it("visible: raised as it is (its size untouched)", () => {
    const w = win({ minimized: false, maximizedAfterRestore: false });
    bringAppToFrontForLink(w as unknown as BrowserWindow);
    expect(w.calls).not.toContain("unmaximize");
    expect(w.calls).not.toContain("maximize");
    expect(w.calls).toContain("focus");
  });
});
