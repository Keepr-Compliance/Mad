/**
 * WHAT THE COMPOSITION ROOT DOES WHEN A CAPABILITY IS MISSING (BACKLOG-2962).
 *
 * Founder decision: the app must name what is missing and then DIE. Before the
 * `catch` in `installNativeCapabilities.ts`, it did neither — SR measured, on
 * this repo's own Electron binary, that the throw produced Electron's default
 * error box several seconds late and then a process that kept running with no
 * window until it was force-quit (PR #2515 review, probes A/B/C).
 *
 * Founder question after the 2026-09-06 launch probe: "did it also fire a
 * Sentry log?" — it could not, and now it must. So the `catch` does five
 * things in a fixed order: text to both sinks, the failure recorded for
 * `main.ts`, the exception captured, the flush awaited, and only THEN the box
 * and the exit. Order is the whole content of this file. Two traps sit in it:
 * `app.exit(1)` before the box ends the process before the box can render
 * (SR measured both orders), and `app.exit(1)` before the flush settles ends
 * the process with the event still inside the transport.
 *
 * The flush is a promise, and the module cannot `await` at top level, so the
 * box and the exit live in its continuation. Every case therefore controls
 * the flush explicitly — deferred, resolved, or rejected — and `settle()`s it
 * before looking at the box. A case that forgot to settle would see no box
 * and no exit, which is exactly the trap; the "does not show the box until
 * the flush settles" case is that trap turned into an assertion.
 *
 * The failure is provoked by mocking `secretStoreProvider` so that installing
 * does not install: `isSecretStoreInstalled()` stays false, which is exactly
 * the state `assertNativeCapabilitiesInstalled()` exists to catch. Nothing here
 * mutates the real registry — every load happens inside `jest.isolateModules`.
 */

interface Probe {
  showErrorBox: jest.Mock;
  exit: jest.Mock;
  logError: jest.Mock;
  consoleError: jest.Mock;
  captureException: jest.Mock;
  flush: jest.Mock;
  /** Resolve a deferred flush (no-op otherwise) and drain the microtask queue. */
  settle: () => Promise<void>;
  /** `getStartupFailure()` from the SAME registry the module wrote to. */
  getStartupFailure: () => Error | null;
}

/**
 * How the mocked `Sentry.flush` behaves.
 *   - deferred: pending until `settle()` — the enabled case, where the real
 *     transport waits for `app.whenReady()` and then a network round-trip
 *   - resolved: settles at once with the given value — the disabled case
 *     (no transport → `true`), or a timeout (`false`)
 *   - rejected: a transport failure
 */
type FlushMode =
  | { kind: "deferred" }
  | { kind: "resolved"; value: boolean }
  | { kind: "rejected"; error: Error };

function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Load the real composition root in a fresh registry.
 *
 * @param install false to make `installSecretStore` a no-op, so the registry
 *   reports the capability uninstalled and the assertion fires.
 * @param flush how `Sentry.flush` behaves; defaults to deferred.
 */
function loadCompositionRoot(options: { install: boolean; flush?: FlushMode }): Probe {
  const mode: FlushMode = options.flush ?? { kind: "deferred" };
  const showErrorBox = jest.fn();
  const exit = jest.fn();
  const logError = jest.fn();
  const captureException = jest.fn(() => "0123456789abcdef0123456789abcdef");
  let resolveFlush: (value: boolean) => void = () => undefined;
  const flush = jest.fn((): Promise<boolean> => {
    if (mode.kind === "resolved") return Promise.resolve(mode.value);
    if (mode.kind === "rejected") return Promise.reject(mode.error);
    return new Promise<boolean>((resolve) => {
      resolveFlush = resolve;
    });
  });
  let getStartupFailure: () => Error | null = () => null;
  // Swapped by hand rather than with `jest.spyOn`, and restored in a `finally`
  // below. `jest.spyOn` over an already-spied `console.error` WRAPS the previous
  // spy instead of replacing it, and `jest.restoreAllMocks()` in an `afterEach`
  // did not unwind the chain here — measured: the first case's spy went on
  // recording later cases' calls and this count read 3 instead of 1.
  const consoleError = jest.fn();
  const realConsoleError = console.error;
  console.error = consoleError as unknown as typeof console.error;

  try {
    jest.isolateModules(() => {
      // Only three members of the Electron surface are reachable from this
      // module's tree: `safeStorage`, which `ElectronSecretStore` imports, and
      // the `app` and `dialog` the catch below uses. The `safeStorage` shape is
      // transcribed from `tests/__mocks__/electron.js` rather than invented; that
      // file cannot be required here, because jest's `moduleNameMapper` maps
      // "electron" onto it and requiring it by path recurses until the stack
      // blows — measured, not guessed.
      jest.doMock("electron", () => ({
        app: { exit },
        dialog: { showErrorBox },
        safeStorage: {
          isEncryptionAvailable: jest.fn(() => true),
          encryptString: jest.fn((text: string) => Buffer.from(`encrypted:${text}`)),
          decryptString: jest.fn((buffer: Buffer) =>
            buffer.toString().replace("encrypted:", ""),
          ),
        },
      }));

      if (!options.install) {
        jest.doMock("../../capabilities/secretStoreProvider", () => ({
          // Accepts the implementation and drops it — the shape of a shell that
          // wired the call up but not the wiring behind it.
          installSecretStore: jest.fn(),
          isSecretStoreInstalled: (): boolean => false,
          getSecretStore: jest.fn(),
        }));
      }

      // electron-log must be mocked HERE and not left to the global
      // `moduleNameMapper` entry: the catch writes through it, and this test has
      // to hold the same `jest.fn()` the module called in order to assert WHEN it
      // was called. A real transport would also reach `app.getPath`, which the
      // Electron mock above does not supply, and would throw inside the catch —
      // reddening this suite for a reason that has nothing to do with the guard.
      jest.doMock("electron-log", () => {
        const mock = { error: logError };
        return { ...mock, default: mock };
      });

      // Same reason for Sentry: the global `tests/__mocks__/sentry-electron.js`
      // has no `flush`, and the catch calls it. Mocked here, not added to the
      // shared file — this suite is the only one that reaches the catch.
      jest.doMock("@sentry/electron/main", () => ({ captureException, flush }));

      // The record `main.ts` reads. Required inside the isolate so the getter
      // belongs to the registry the module wrote to, not to this file's.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const record = require("../startupFailure") as { getStartupFailure: () => Error | null };
      getStartupFailure = record.getStartupFailure;

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("../installNativeCapabilities");
    });
  } finally {
    console.error = realConsoleError;
    jest.dontMock("electron");
    jest.dontMock("electron-log");
    jest.dontMock("@sentry/electron/main");
    jest.dontMock("../../capabilities/secretStoreProvider");
  }

  const settle = async (): Promise<void> => {
    if (mode.kind === "deferred") resolveFlush(true);
    await drain();
  };

  return { showErrorBox, exit, logError, consoleError, captureException, flush, settle, getStartupFailure };
}

describe("composition root: a missing capability at launch (BACKLOG-2962)", () => {

  it("names the missing capability in the error box", async () => {
    const probe = loadCompositionRoot({ install: false });
    await probe.settle();

    expect(probe.showErrorBox).toHaveBeenCalledTimes(1);
    const [title, message] = probe.showErrorBox.mock.calls[0] as [string, string];
    expect(title).toBe("Keepr cannot start");
    // Named, not merely non-empty: a box that says "something went wrong"
    // sends the reader nowhere.
    expect(message).toContain("secretStore");
    expect(message).toContain("composition root");
  });

  it("exits the process with code 1, so a failed launch is observable", async () => {
    const probe = loadCompositionRoot({ install: false });
    await probe.settle();

    expect(probe.exit).toHaveBeenCalledTimes(1);
    expect(probe.exit).toHaveBeenCalledWith(1);
  });

  it("writes the error to the log and to stderr BEFORE the box, because the box does not survive", async () => {
    // The box is dismissed and gone, and an unattended launch has nobody to
    // dismiss it. Before this write existed, `npm run dev` failed with an empty
    // terminal — a regression, because the throw it replaced at least reached
    // Electron's default handler, which printed a stack.
    //
    // Order is asserted, not just the calls: text after the box would be text
    // nobody reads, and text after `app.exit(1)` would never run at all.
    const probe = loadCompositionRoot({ install: false });
    await probe.settle();
    const { logError, consoleError, showErrorBox } = probe;

    expect(logError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);

    // The whole error object, not the message: that is what carries the stack
    // into both sinks, and it is what `main.ts` passes on its own fatal path.
    const logged = logError.mock.calls[0][1] as unknown;
    expect(logged).toBeInstanceOf(Error);
    expect((logged as Error).message).toContain("secretStore");
    expect((logged as Error).stack).toBeTruthy();

    expect(consoleError.mock.invocationCallOrder[0]).toBeLessThan(
      showErrorBox.mock.invocationCallOrder[0],
    );
    expect(logError.mock.invocationCallOrder[0]).toBeLessThan(
      showErrorBox.mock.invocationCallOrder[0],
    );
  });

  it("shows the box BEFORE exiting — the other order would suppress it", async () => {
    const probe = loadCompositionRoot({ install: false });
    await probe.settle();

    expect(probe.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(
      probe.exit.mock.invocationCallOrder[0],
    );
  });

  it("does neither when every capability installs, so the cases above are not vacuous", async () => {
    // The real provider, the real ElectronSecretStore. If this fired, the
    // assertions above would be describing the ordinary launch path rather
    // than a failure, and would say nothing.
    const probe = loadCompositionRoot({ install: true });
    await probe.settle();

    expect(probe.showErrorBox).not.toHaveBeenCalled();
    expect(probe.exit).not.toHaveBeenCalled();
    expect(probe.logError).not.toHaveBeenCalled();
    expect(probe.consoleError).not.toHaveBeenCalled();
    expect(probe.captureException).not.toHaveBeenCalled();
    expect(probe.flush).not.toHaveBeenCalled();
    expect(probe.getStartupFailure()).toBeNull();
  });
});

describe("composition root: the failure reaches Sentry before the app exits (BACKLOG-2962, 2026-09-06)", () => {

  it("captures the error AFTER the text writes, with the missing capability in tags and extra", () => {
    const { captureException, consoleError, logError } = loadCompositionRoot({ install: false });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = captureException.mock.calls[0] as [
      unknown,
      { tags?: Record<string, string>; extra?: Record<string, string> },
    ];
    // The same Error object both sinks received — one stack, three places.
    expect(captured).toBe(logError.mock.calls[0][1]);
    expect(context.tags).toEqual({ component: "composition-root" });
    expect(context.extra?.missingCapabilities).toContain("secretStore");

    // Text first: the sinks that survive the process must not depend on the
    // network path that follows.
    expect(consoleError.mock.invocationCallOrder[0]).toBeLessThan(captureException.mock.invocationCallOrder[0]);
    expect(logError.mock.invocationCallOrder[0]).toBeLessThan(captureException.mock.invocationCallOrder[0]);
  });

  it("records the failure for main.ts BEFORE capturing — the ready-time paths read it while the flush is pending", () => {
    const { getStartupFailure, captureException } = loadCompositionRoot({ install: false });

    const recorded = getStartupFailure();
    expect(recorded).toBeInstanceOf(Error);
    expect(recorded?.message).toContain("secretStore");
    // The same object Sentry got.
    expect(captureException.mock.calls[0][0]).toBe(recorded);
  });

  it("flushes with the 2 s ceiling AFTER capturing, and holds the box and the exit until the flush settles", async () => {
    const probe = loadCompositionRoot({ install: false, flush: { kind: "deferred" } });

    expect(probe.flush).toHaveBeenCalledTimes(1);
    expect(probe.flush).toHaveBeenCalledWith(2000);
    expect(probe.captureException.mock.invocationCallOrder[0]).toBeLessThan(probe.flush.mock.invocationCallOrder[0]);

    // Nothing yet — synchronously, and after the microtask queue drains with
    // the flush still pending. An exit here would end the process with the
    // event still inside the transport.
    await drain();
    expect(probe.showErrorBox).not.toHaveBeenCalled();
    expect(probe.exit).not.toHaveBeenCalled();

    await probe.settle();
    expect(probe.showErrorBox).toHaveBeenCalledTimes(1);
    expect(probe.exit).toHaveBeenCalledWith(1);
    expect(probe.flush.mock.invocationCallOrder[0]).toBeLessThan(probe.showErrorBox.mock.invocationCallOrder[0]);
    expect(probe.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(probe.exit.mock.invocationCallOrder[0]);
  });

  it.each([
    ["Sentry disabled — no transport, flush resolves true at once", { kind: "resolved", value: true } as FlushMode],
    ["flush timed out — resolves false", { kind: "resolved", value: false } as FlushMode],
  ])("%s: same box, same exit 1, nothing thrown", async (_name, flush) => {
    // The disabled branch is what every dev checkout without SENTRY_DSN runs.
    // Sentry drops the capture inside itself and `flush` returns `true` with
    // no delay; the fatal path must look exactly as it did before Sentry was
    // involved.
    let probe: Probe | undefined;
    expect(() => {
      probe = loadCompositionRoot({ install: false, flush });
    }).not.toThrow();
    if (!probe) throw new Error("unreachable");
    await drain();

    expect(probe.showErrorBox).toHaveBeenCalledTimes(1);
    expect(probe.showErrorBox.mock.calls[0][0]).toBe("Keepr cannot start");
    expect(probe.exit).toHaveBeenCalledTimes(1);
    expect(probe.exit).toHaveBeenCalledWith(1);
    expect(probe.showErrorBox.mock.invocationCallOrder[0]).toBeLessThan(probe.exit.mock.invocationCallOrder[0]);
  });

  it("a REJECTED flush still ends in the box and exit 1, and the failure is LOGGED — a transport failure must not leave the process windowless and alive, nor vanish without a local trace", async () => {
    const flushError = new Error("transport: ENOTFOUND");
    const probe = loadCompositionRoot({
      install: false,
      flush: { kind: "rejected", error: flushError },
    });
    await drain();

    expect(probe.showErrorBox).toHaveBeenCalledTimes(1);
    expect(probe.exit).toHaveBeenCalledWith(1);
    // A rejected flush is the one case where this PR's promise — the event
    // reached Sentry — has failed, so it is the one case that must not be
    // silent. Call 1 is the fatal path's own `log.error` (the missing
    // capability); call 2 is the flush failure. Identity, not just a count:
    // the line has to carry THIS rejection, not merely be written.
    expect(probe.logError).toHaveBeenCalledTimes(2);
    expect(probe.logError.mock.calls[1][1]).toBe(flushError);
  });
});
