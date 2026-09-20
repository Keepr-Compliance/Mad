/**
 * A PUSH FOLLOWS THE WINDOW, NOT THE REGISTRATION (BACKLOG-3454).
 *
 * On macOS `window-all-closed` deliberately does not quit, so closing the
 * window with the red button leaves the process running and clicking the Dock
 * icon calls `createWindow()` again (`main.ts`, `app.on("activate")`). Every
 * `register*Handlers(mainWindow!)` runs ONCE inside `app.whenReady()`. Before
 * this fix each of those handlers held the FIRST window and, after a reopen,
 * evaluated `if (win && !win.isDestroyed())` against a destroyed object and
 * returned — silently, underneath a `log.info` line that had already announced
 * the send. `ipcMain.handle` kept working throughout, because a handle is
 * sender-agnostic, so the app looked entirely alive while no main->renderer
 * push could reach the renderer again for the life of the process.
 *
 * WHAT THIS SUITE DRIVES, AND WHAT IT SUBSTITUTES
 * ----------------------------------------------
 * The real sequence is: register against window A -> A is destroyed -> `activate`
 * builds window B -> a device event must reach B. `createWindow()` itself cannot
 * run here: `main.ts` is 1,900 lines of module-level side effects and no suite
 * loads it (`main.startupFailureGuards-2962.test.ts` says so in its own header
 * and pins main.ts BY AST instead). So the chain is asserted in two halves:
 *
 *   - the RUNTIME half, below: registration happens once against A, A is
 *     destroyed, B is registered, and the push must arrive at B. Nothing
 *     re-registers — that is the whole point.
 *   - the SOURCE half, below: `createWindow()` hands its new window to the
 *     registry. `main.startupFailureGuards-2962.test.ts` already pins
 *     `activate` -> `createWindow()` and that every `createWindow()` call site
 *     sits inside a guarded handler, so B's creation path is asserted there and
 *     is not restated here.
 *
 * The two services are replaced by bare `EventEmitter`s. They ARE EventEmitters
 * (`DeviceDetectionService extends EventEmitter`, `DeviceSyncOrchestrator extends
 * EventEmitter`) and the handlers' only contact with them is `.on(event, cb)`, so
 * the shape is exact; the substitution avoids constructing a backup/parser stack
 * and spawning `idevice*` subprocesses to deliver an event this suite emits itself.
 *
 * NOT A CONTROL FOR THIS DEFECT: `src/contexts/__tests__/iphoneSyncDeviceConnected-3454.test.tsx`
 * (committed 5f9f15ec7). Those tests mock `window.api.sync`, which bypasses
 * `webContents.send` -> preload -> contextBridge — precisely the layer that was
 * dropping. They are kept and they are non-vacuous, but they cover the renderer's
 * subscribe -> callback -> state path when the bridge delivers. They cannot see this.
 */

import { EventEmitter } from "events";
import fs from "fs";
import path from "path";

import ts from "typescript";

const deviceEvents = new EventEmitter();
const orchestratorEvents = new EventEmitter();

jest.mock("electron", () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() },
  BrowserWindow: jest.fn(),
}));

jest.mock("../../services/deviceDetectionService", () => ({
  deviceDetectionService: deviceEvents,
}));

jest.mock("../../services/deviceSyncOrchestrator", () => ({
  deviceSyncOrchestrator: orchestratorEvents,
  DeviceSyncOrchestrator: class {},
}));

jest.mock("../../services/iPhoneSyncStorageService", () => ({ iPhoneSyncStorageService: {} }));
jest.mock("../../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn(),
  expandAttachedThreadsForUser: jest.fn(),
}));
jest.mock("../../services/sessionService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/syncStatusService", () => ({ syncStatusService: {} }));
jest.mock("../../services/syncTimeline", () => ({ syncTimeline: { start: jest.fn(), annotate: jest.fn(), end: jest.fn() } }));

import log from "electron-log";

import { registerDeviceHandlers } from "../deviceHandlers";
import { registerSyncHandlers } from "../syncHandlers";
import { getMainWindow, sendToMainWindow, setMainWindow } from "../../windowRegistry";

const mockWarn = log.warn as jest.Mock;

/** A stand-in window that records what was pushed to it. */
function makeWindow(name: string) {
  let destroyed = false;
  const send = jest.fn();
  return {
    name,
    send,
    destroy: () => { destroyed = true; },
    win: { isDestroyed: () => destroyed, webContents: { send } },
  };
}

const DEVICE = { udid: "0000-DEVICE", name: "Test iPhone" };

describe("a push reaches the window that exists now, not the one registration saw (BACKLOG-3454)", () => {
  let A: ReturnType<typeof makeWindow>;
  let B: ReturnType<typeof makeWindow>;

  beforeEach(() => {
    jest.clearAllMocks();
    deviceEvents.removeAllListeners();
    orchestratorEvents.removeAllListeners();

    A = makeWindow("A");
    B = makeWindow("B");

    // Exactly what `app.whenReady()` does: one window, one registration.
    setMainWindow(A.win as never);
    registerDeviceHandlers(A.win as never);
    registerSyncHandlers(A.win as never);
  });

  afterEach(() => {
    setMainWindow(null);
  });

  it("delivers to the first window while it is the live one", () => {
    deviceEvents.emit("device-connected", DEVICE);
    orchestratorEvents.emit("progress", { phase: "backup", percent: 10 });

    expect(A.send).toHaveBeenCalledWith("device:connected", DEVICE);
    expect(A.send).toHaveBeenCalledWith("sync:progress", { phase: "backup", percent: 10 });
  });

  /**
   * THE CONTROL. The red button then the Dock icon, with no re-registration.
   *
   * MUTATION: restore `deviceHandlers.ts`'s captured guard --
   * `if (_mainWindow && !_mainWindow.isDestroyed()) { _mainWindow.webContents.send(...) }`
   * -> RED here, green everywhere else, because every other suite registers and
   * sends against one window that never dies.
   */
  it("delivers to the window created after the first one was closed, with no re-registration", () => {
    A.destroy();
    setMainWindow(B.win as never);

    deviceEvents.emit("device-connected", DEVICE);

    expect(B.send).toHaveBeenCalledWith("device:connected", DEVICE);
    expect(A.send).not.toHaveBeenCalled();
  });

  it("does the same for the sync orchestrator's progress and device events", () => {
    A.destroy();
    setMainWindow(B.win as never);

    orchestratorEvents.emit("progress", { phase: "parsing", percent: 42 });
    orchestratorEvents.emit("device-connected", DEVICE);

    expect(B.send).toHaveBeenCalledWith("sync:progress", { phase: "parsing", percent: 42 });
    expect(B.send).toHaveBeenCalledWith("sync:device-connected", DEVICE);
    expect(A.send).not.toHaveBeenCalled();
  });

  /**
   * The founder's 55-minute session, reproduced: FIVE device-connected events
   * and a re-plug, every one of them after the reopen, none of them arriving.
   * A count assertion rather than a "was called" one, because the original
   * defect dropped all of them and a single-event test cannot tell a fixed
   * sender from one that happens to deliver the first event only.
   */
  it("keeps delivering to the new window for every later event, not just the first", () => {
    A.destroy();
    setMainWindow(B.win as never);

    for (let i = 0; i < 5; i++) deviceEvents.emit("device-connected", DEVICE);
    deviceEvents.emit("device-disconnected", DEVICE);
    deviceEvents.emit("device-connected", DEVICE);

    expect(B.send.mock.calls.filter((c) => c[0] === "device:connected")).toHaveLength(6);
    expect(B.send).toHaveBeenCalledWith("device:disconnected", DEVICE);
  });

  it("treats a destroyed window as no window, so a push is never sent to it", () => {
    A.destroy();

    deviceEvents.emit("device-connected", DEVICE);

    expect(A.send).not.toHaveBeenCalled();
    expect(getMainWindow()).toBeNull();
  });

  /**
   * THE SECOND CONTROL: the drop is LOUD.
   *
   * A silent return is what hid this defect for a 70-minute QA session — main's
   * log read as if every event had been sent.
   *
   * MUTATION: delete the `log.warn(...)` call in `windowRegistry.ts` -> RED.
   */
  it("logs a warning naming the channel when there is no live window to push to", () => {
    A.destroy();

    deviceEvents.emit("device-connected", DEVICE);

    expect(mockWarn).toHaveBeenCalled();
    const warned = mockWarn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("device:connected");
  });

  it("warns with the channel only — a payload on these channels carries device names", () => {
    setMainWindow(null);

    sendToMainWindow("sync:device-connected", {
      udid: "INVENTED-UDID-NOT-A-REAL-DEVICE",
      name: "Invented Owner iPhone",
    });

    const warned = mockWarn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("sync:device-connected");
    expect(warned).not.toContain("INVENTED-UDID-NOT-A-REAL-DEVICE");
    expect(warned).not.toContain("Invented Owner");
  });

  it("reports whether the push left, so a caller can fall back", () => {
    expect(sendToMainWindow("sync:phase", "backup")).toBe(true);
    A.destroy();
    expect(sendToMainWindow("sync:phase", "backup")).toBe(false);
  });

  /**
   * `device:tools-missing` is sent with NO payload. `send(channel, undefined)`
   * delivers an argument, which is not the same thing — a rest parameter is
   * what keeps the arity exact.
   */
  it("preserves a zero-payload push's arity", () => {
    deviceEvents.emit("tools-missing");

    const call = A.send.mock.calls.find((c) => c[0] === "device:tools-missing");
    expect(call).toBeDefined();
    expect(call).toHaveLength(1);
  });
});

/**
 * THE SOURCE HALF. `createWindow()` is the sole writer of the registry, and the
 * runtime half above is worth nothing if that line is not there: every push
 * would resolve `null` and the app would be as dead as it was before, only
 * noisier.
 *
 * MUTATION: delete `setMainWindow(mainWindow);` from `createWindow()` -> RED.
 */
describe("main.ts hands every new window to the registry (BACKLOG-3454)", () => {
  const MAIN_TS = path.resolve(__dirname, "../../main.ts");
  const source = ts.createSourceFile(
    MAIN_TS,
    fs.readFileSync(MAIN_TS, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  function createWindowFn(): ts.FunctionDeclaration {
    const found = source.statements.filter(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === "createWindow",
    );
    expect(found).toHaveLength(1);
    return found[0];
  }

  it("imports setMainWindow as a value from ./windowRegistry", () => {
    const imports = source.statements.filter(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === "./windowRegistry",
    );
    expect(imports).toHaveLength(1);
    const clause = imports[0].importClause;
    expect(clause?.isTypeOnly).toBeFalsy();
    const named = clause?.namedBindings as ts.NamedImports;
    expect(named.elements.map((e) => e.name.text)).toContain("setMainWindow");
  });

  it("calls setMainWindow(mainWindow) inside createWindow, after the assignment", () => {
    const fn = createWindowFn();
    const body = fn.body!.getText(source);
    expect(body).toContain("setMainWindow(mainWindow);");
    expect(body.indexOf("mainWindow = new BrowserWindow(")).toBeLessThan(
      body.indexOf("setMainWindow(mainWindow);"),
    );
  });

  it("has exactly one writer of the registry in the whole main process", () => {
    const calls: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "setMainWindow") {
        calls.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls).toEqual(["setMainWindow(mainWindow)"]);
  });
});
