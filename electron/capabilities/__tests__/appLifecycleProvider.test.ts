/**
 * The AppLifecycle composition seam (BACKLOG-2962, seams PR B).
 *
 * Mirrors `appPathsProvider.test.ts`: this default THROWS, and the reason is
 * asserted rather than described. None of the four members has an honest no-op
 * — `isPackaged()` answering either way silently arms or disarms a test-only
 * delay seam, `isReady()` answering either way either hangs startup or sends a
 * caller into a dialog that cannot render, and a `quit()` that does not quit
 * leaves the app running on a database it has already condemned.
 */

import {
  AppLifecycleUnavailableError,
  UnavailableAppLifecycle,
  type AppLifecycle,
} from "../appLifecycle";
import {
  getAppLifecycle,
  hostAppLifecycle,
  installAppLifecycle,
  isAppLifecycleInstalled,
  resetAppLifecycle,
} from "../appLifecycleProvider";

function fake(overrides: Partial<AppLifecycle> = {}): AppLifecycle {
  return {
    isPackaged: () => true,
    isReady: () => true,
    whenReady: async () => {},
    quit: () => {},
    ...overrides,
  };
}

describe("appLifecycleProvider (BACKLOG-2962)", () => {
  afterEach(() => {
    // tests/setup.js installed one for this file; put a real one back so no
    // later case in this file inherits the throwing default.
    installAppLifecycle(fake());
  });

  it("reports NOT installed while the throwing default is in force", () => {
    resetAppLifecycle();
    expect(isAppLifecycleInstalled()).toBe(false);
    expect(getAppLifecycle()).toBeInstanceOf(UnavailableAppLifecycle);
  });

  it("every member of the default throws, naming itself", () => {
    resetAppLifecycle();
    expect(() => hostAppLifecycle.isPackaged()).toThrow(AppLifecycleUnavailableError);
    expect(() => hostAppLifecycle.isPackaged()).toThrow(/isPackaged cannot be answered/);
    expect(() => hostAppLifecycle.isReady()).toThrow(/isReady cannot be answered/);
    expect(() => hostAppLifecycle.whenReady()).toThrow(/whenReady cannot be answered/);
    expect(() => hostAppLifecycle.quit()).toThrow(/quit cannot be answered/);
    // All four point at the composition root, so a developer meeting one in a
    // new shell is told what to do rather than what went wrong.
    expect(() => hostAppLifecycle.quit()).toThrow(/installNativeCapabilities/);
  });

  it("forwards each member to whatever is installed", async () => {
    const quit = jest.fn();
    installAppLifecycle(fake({ isPackaged: () => false, isReady: () => false, quit }));
    expect(hostAppLifecycle.isPackaged()).toBe(false);
    expect(hostAppLifecycle.isReady()).toBe(false);
    await expect(hostAppLifecycle.whenReady()).resolves.toBeUndefined();
    hostAppLifecycle.quit();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("reads isPackaged PER CALL, so a value that changes is seen", () => {
    // `app.isPackaged` is a property, and it is the member most likely to be
    // captured at construction. Its one caller gates a delay seam that must be
    // dead code in a packaged build; an implementation that froze `false` at
    // install time would arm that seam in production.
    let packaged = false;
    installAppLifecycle(fake({ isPackaged: () => packaged }));
    expect(hostAppLifecycle.isPackaged()).toBe(false);
    packaged = true;
    expect(hostAppLifecycle.isPackaged()).toBe(true);
  });

  it("forwards at CALL time, not at bind time", () => {
    // `databaseService` binds `hostAppLifecycle` when its module loads, which is
    // before any shell has installed anything.
    resetAppLifecycle();
    const bound = hostAppLifecycle;
    installAppLifecycle(fake({ isPackaged: () => false }));
    expect(bound.isPackaged()).toBe(false);
  });

  it("installing twice replaces the implementation", () => {
    installAppLifecycle(fake({ isPackaged: () => true }));
    installAppLifecycle(fake({ isPackaged: () => false }));
    expect(hostAppLifecycle.isPackaged()).toBe(false);
  });

  it("resetAppLifecycle puts the throwing default back", () => {
    installAppLifecycle(fake());
    expect(isAppLifecycleInstalled()).toBe(true);
    resetAppLifecycle();
    expect(isAppLifecycleInstalled()).toBe(false);
  });
});
