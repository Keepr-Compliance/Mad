/**
 * BACKLOG-3456 — every main window gets crash / unresponsive recovery, not only
 * the first.
 *
 * On macOS `window-all-closed` does not quit; the Dock icon fires `activate`,
 * which calls `createWindow()` again. The recovery wiring used to sit in
 * `app.whenReady()`, bound to the first window, so the reopened window had no
 * crash dialog and no freeze tracking.
 *
 * Two halves, because `main.ts` cannot load in jest (see
 * `windowRecreation-3454.test.ts`):
 *   - RUNTIME: attach to A, close A, attach to B; a crash / freeze on B is
 *     handled ON B.
 *   - SOURCE: `createWindow()` is what calls `attachWindowRecovery`, and nothing
 *     else in main.ts wires these events. `activate` -> `createWindow()` is
 *     pinned by `main.startupFailureGuards-2962.test.ts`.
 */

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

import ts from "typescript";

import { attachWindowRecovery, type WindowRecoveryDeps } from "../attachWindowRecovery";
import {
  WindowResponsivenessTracker,
  attachResponsivenessTracking,
} from "../../services/windowResponsivenessTracker";

interface FakeWindow extends EventEmitter {
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: EventEmitter & { reload: jest.Mock };
}

function fakeWindow(): FakeWindow {
  const win = new EventEmitter() as FakeWindow;
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.webContents = Object.assign(new EventEmitter(), { reload: jest.fn() });
  return win;
}

function makeDeps(overrides: Partial<WindowRecoveryDeps> = {}): WindowRecoveryDeps & {
  showCrashDialog: jest.Mock;
  promptUnresponsive: jest.Mock;
  quit: jest.Mock;
  createTracker: jest.Mock;
} {
  return {
    isPackaged: () => true,
    showCrashDialog: jest.fn().mockResolvedValue(0),
    promptUnresponsive: jest.fn().mockResolvedValue(1),
    reportCrash: jest.fn(),
    logError: jest.fn(),
    warn: jest.fn(),
    createTracker: jest.fn(
      () => new WindowResponsivenessTracker({ log: jest.fn(), capture: jest.fn() }),
    ),
    attachTracking: attachResponsivenessTracking,
    noteUserReload: jest.fn(),
    quit: jest.fn(),
    ...overrides,
  } as never;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("BACKLOG-3456: recovery follows each window", () => {
  it("handles a renderer crash on a window created after the first one closed", async () => {
    const deps = makeDeps();
    const windowA = fakeWindow();
    attachWindowRecovery(windowA, deps); // first createWindow()
    windowA.emit("closed");
    const windowB = fakeWindow();
    attachWindowRecovery(windowB, deps); // activate -> createWindow()

    windowB.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    await flush();

    expect(deps.showCrashDialog).toHaveBeenCalledWith("crashed");
    expect(windowB.webContents.reload).toHaveBeenCalledTimes(1);
    expect(windowA.webContents.reload).not.toHaveBeenCalled();
  });

  it("handles an unresponsive window B, and reloads B", async () => {
    const deps = makeDeps();
    attachWindowRecovery(fakeWindow(), deps);
    const windowB = fakeWindow();
    attachWindowRecovery(windowB, deps);

    windowB.emit("unresponsive");
    await flush();

    expect(deps.promptUnresponsive).toHaveBeenCalledTimes(1);
    expect(deps.noteUserReload).toHaveBeenCalledTimes(1);
    expect(windowB.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload a window destroyed while its dialog was open", async () => {
    let answerCrash!: (n: number) => void;
    let answerFreeze!: (n: number) => void;
    const deps = makeDeps({
      showCrashDialog: jest.fn(() => new Promise<number>((r) => { answerCrash = r; })),
      promptUnresponsive: jest.fn(() => new Promise<number>((r) => { answerFreeze = r; })),
    });
    const win = fakeWindow();
    attachWindowRecovery(win, deps);
    win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    win.emit("unresponsive");
    await flush();
    win.destroyed = true;
    answerCrash(0);
    answerFreeze(1);
    await flush();
    expect(win.webContents.reload).not.toHaveBeenCalled();
  });

  it("gives each window its own freeze tracker", () => {
    const deps = makeDeps();
    attachWindowRecovery(fakeWindow(), deps);
    attachWindowRecovery(fakeWindow(), deps);
    expect(deps.createTracker).toHaveBeenCalledTimes(2);
  });

  it("Quit on the crash dialog quits; dev 'killed' shows no dialog", async () => {
    const deps = makeDeps({ showCrashDialog: jest.fn().mockResolvedValue(1) });
    const win = fakeWindow();
    attachWindowRecovery(win, deps);
    win.webContents.emit("render-process-gone", {}, { reason: "oom", exitCode: 1 });
    await flush();
    expect(deps.quit).toHaveBeenCalledTimes(1);

    const devDeps = makeDeps({ isPackaged: () => false });
    const devWin = fakeWindow();
    attachWindowRecovery(devWin, devDeps);
    devWin.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 0 });
    await flush();
    expect(devDeps.showCrashDialog).not.toHaveBeenCalled();
  });
});

/**
 * MUTATION: move `attachWindowRecovery(mainWindow, windowRecoveryDeps)` out of
 * `createWindow()` into `whenReady` (first window only) -> RED.
 */
describe("main.ts attaches recovery inside createWindow (BACKLOG-3456)", () => {
  const MAIN_TS = path.resolve(__dirname, "../../main.ts");
  const text = fs.readFileSync(MAIN_TS, "utf8");
  const source = ts.createSourceFile(MAIN_TS, text, ts.ScriptTarget.Latest, true);

  function callsNamed(name: string): ts.CallExpression[] {
    const out: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === name) out.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  }

  function enclosingFunctionName(node: ts.Node): string | undefined {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n)) return n.name?.text;
    }
    return undefined;
  }

  it("calls attachWindowRecovery exactly once, inside createWindow, after setMainWindow", () => {
    const calls = callsNamed("attachWindowRecovery");
    expect(calls).toHaveLength(1);
    expect(enclosingFunctionName(calls[0])).toBe("createWindow");
    const [setCall] = callsNamed("setMainWindow");
    expect(setCall.getStart(source)).toBeLessThan(calls[0].getStart(source));
  });

  it("wires no recovery event directly in main.ts (no first-window-only copy left)", () => {
    expect(text).not.toMatch(/["']render-process-gone["']/);
    expect(callsNamed("attachResponsivenessTracking")).toHaveLength(0);
  });
});
