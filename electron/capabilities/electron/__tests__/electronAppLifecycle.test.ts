/**
 * `ElectronAppLifecycle` — the Electron shell's AppLifecycle
 * (BACKLOG-2962, seams PR B).
 *
 * Written for the reason `electronDialog.test.ts` records: the test shell
 * installs a call-time forwarder, not this class, so no other suite exercises
 * it, and a defect here is invisible to the whole tree (SR's S4 on PR #2523).
 *
 * The property that would actually break the product is the PER-CALL read of
 * `app.isPackaged`. This adapter is constructed during `main.ts` evaluation; an
 * implementation that captured the value there would freeze it — the shape
 * `ElectronAppPaths` documents for `app.getPath` and the shape of the
 * BACKLOG-2709 incident — and its one caller gates a delay seam that must be
 * dead code in a shipped build.
 */

import { app } from "electron";

import { ElectronAppLifecycle } from "../electronAppLifecycle";

const mockQuit = app.quit as unknown as jest.Mock;
const mockWhenReady = app.whenReady as unknown as jest.Mock;
const mockIsReady = jest.fn(() => true);

beforeAll(() => {
  // The shared `tests/__mocks__/electron.js` has never had an `isReady`, and it
  // is deliberately not given one there: a suite that reaches that path without
  // its own mock must fail exactly as it did before this seam existed. Attached
  // locally so this adapter's own behaviour can be pinned.
  (app as unknown as { isReady: unknown }).isReady = mockIsReady;
});

describe("ElectronAppLifecycle (BACKLOG-2962)", () => {
  beforeEach(() => {
    mockQuit.mockClear();
    mockWhenReady.mockClear();
    mockIsReady.mockClear();
  });

  it("reads app.isPackaged on EVERY call, never once at construction", () => {
    const lifecycle = new ElectronAppLifecycle();
    (app as unknown as { isPackaged: boolean }).isPackaged = false;
    expect(lifecycle.isPackaged()).toBe(false);
    (app as unknown as { isPackaged: boolean }).isPackaged = true;
    expect(lifecycle.isPackaged()).toBe(true);
    (app as unknown as { isPackaged: boolean }).isPackaged = false;
  });

  it("forwards isReady and whenReady to app", async () => {
    const lifecycle = new ElectronAppLifecycle();
    expect(lifecycle.isReady()).toBe(true);
    expect(mockIsReady).toHaveBeenCalledTimes(1);
    await lifecycle.whenReady();
    expect(mockWhenReady).toHaveBeenCalledTimes(1);
  });

  it("quit() is app.quit() — the cancellable shutdown, NOT app.exit()", () => {
    // `app.exit(code)` is the composition root's fatal path and a different
    // decision: it ends the process immediately and skips `before-quit`. Both
    // call sites here are terminal database failures where a graceful quit is
    // what was written.
    const lifecycle = new ElectronAppLifecycle();
    lifecycle.quit();
    expect(mockQuit).toHaveBeenCalledTimes(1);
    expect(mockQuit).toHaveBeenCalledWith();
    expect((app as unknown as { exit?: unknown }).exit).toBeUndefined();
  });

  it("constructing it touches nothing", () => {
    new ElectronAppLifecycle();
    expect(mockQuit).not.toHaveBeenCalled();
    expect(mockWhenReady).not.toHaveBeenCalled();
    expect(mockIsReady).not.toHaveBeenCalled();
  });
});
