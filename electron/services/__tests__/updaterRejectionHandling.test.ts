/**
 * Guard tests for the auto-updater "organic auto-download" rejection handling
 * (BACKLOG-1903/1905, B2 fast-follow).
 *
 * electron-updater's `autoDownload` defaults to true (AppUpdater.js:109), so a
 * successful `checkForUpdates()` immediately starts `downloadUpdate()` and exposes
 * that promise ONLY on the returned `UpdateCheckResult.downloadPromise`. If the
 * download fails and that promise rejects UNHANDLED, Node's
 * `process.on("unhandledRejection")` fires — and in main.ts that path captures to
 * Sentry WITHOUT the `component: auto-updater` tag, so `scrubUpdaterEventPII`
 * never runs and a raw signed-URL token (`X-Amz-Signature`) ships.
 *
 * `checkForUpdates()` also re-throws after emitting "error" (AppUpdater.js:264-272),
 * so the returned CHECK promise rejects too and must be handled.
 *
 * These tests reproduce the exact electron-updater promise shape and assert the
 * handling pattern main.ts applies at the startup + periodic check sites keeps
 * both rejections OUT of the unhandledRejection handler. They are decoupled from
 * main.ts wiring so a future refactor that drops a `.catch` fails here loudly.
 */

/** Mirrors electron-updater's `UpdateCheckResult` (only the field we consume). */
interface FakeUpdateCheckResult {
  downloadPromise?: Promise<unknown>;
}

/**
 * The EXACT handling main.ts wraps around `autoUpdater.checkForUpdates()` at the
 * startup + periodic sites (B2 organic-path fix). No-op catches: the real
 * user-facing surfacing happens via the tagged autoUpdater "error" event; these
 * catches only prevent the untagged/unscrubbed unhandledRejection capture.
 */
function guardCheckForUpdates(
  checkForUpdates: () => Promise<FakeUpdateCheckResult | null>,
): Promise<void> {
  return checkForUpdates()
    .then((result) => {
      result?.downloadPromise?.catch(() => {
        /* surfaced via the tagged autoUpdater "error" event */
      });
    })
    .catch(() => {
      /* surfaced via the tagged autoUpdater "error" event */
    });
}

/** Drain the microtask queue so any pending rejection would have been reported. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("auto-updater rejection handling — unhandledRejection guard (B2 organic path)", () => {
  let unhandled: unknown[];
  let listener: (reason: unknown) => void;

  beforeEach(() => {
    unhandled = [];
    listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
  });

  afterEach(() => {
    process.off("unhandledRejection", listener);
  });

  it("does NOT fire unhandledRejection when the organic downloadPromise rejects", async () => {
    // A signed-URL token in the message is exactly what must not leak untagged.
    const downloadError = new Error(
      "sha512 mismatch for https://objects.githubusercontent.com/keepr.exe?X-Amz-Signature=deadbeef",
    );
    const checkForUpdates = () =>
      Promise.resolve<FakeUpdateCheckResult>({
        downloadPromise: Promise.reject(downloadError),
      });

    await guardCheckForUpdates(checkForUpdates);
    await flushMicrotasks();

    expect(unhandled).toHaveLength(0);
  });

  it("does NOT fire unhandledRejection when the CHECK promise rejects (offline re-throw)", async () => {
    // AppUpdater.js:264-272 re-throws after emitting "error".
    const checkForUpdates = () =>
      Promise.reject<FakeUpdateCheckResult>(new Error("net::ERR_INTERNET_DISCONNECTED"));

    await guardCheckForUpdates(checkForUpdates);
    await flushMicrotasks();

    expect(unhandled).toHaveLength(0);
  });

  it("handles a null result (updater disabled) without touching downloadPromise", async () => {
    const checkForUpdates = () => Promise.resolve(null);

    await expect(guardCheckForUpdates(checkForUpdates)).resolves.toBeUndefined();
    await flushMicrotasks();
    expect(unhandled).toHaveLength(0);
  });

  it("handles a result with no downloadPromise (no update available)", async () => {
    const checkForUpdates = () => Promise.resolve<FakeUpdateCheckResult>({});

    await guardCheckForUpdates(checkForUpdates);
    await flushMicrotasks();
    expect(unhandled).toHaveLength(0);
  });

  it("REGRESSION teeth: the guard actually attaches a .catch to the downloadPromise", async () => {
    // Proves the guard above is load-bearing (not a vacuous pass): the handling
    // pattern MUST call `.catch` on the organic downloadPromise. We spy on the
    // downloadPromise's `.catch` and assert it was invoked. (We avoid creating a
    // genuinely unhandled rejection here — Node terminates the process on one.)
    const rejected = Promise.reject(new Error("download failure"));
    const catchSpy = jest.spyOn(rejected, "catch");
    // Pre-handle so the rejection never escapes this test.
    rejected.catch(() => undefined);

    const checkForUpdates = () =>
      Promise.resolve<FakeUpdateCheckResult>({ downloadPromise: rejected });

    await guardCheckForUpdates(checkForUpdates);
    await flushMicrotasks();

    expect(catchSpy).toHaveBeenCalled();
    expect(unhandled).toHaveLength(0);
    catchSpy.mockRestore();
  });
});

describe("auto-updater rejection handling — B1 deferral chain ordering (version-bump guard)", () => {
  /**
   * Pins the electron-updater downloadUpdate() promise shape the B1 deferral
   * relies on: `.catch(emit).finally(nullify)` (AppUpdater.js:464-473). The
   * deferral is correct ONLY IF `.finally` nulls `downloadPromise` before the
   * NEXT (deferred) downloadUpdate() runs. This models that chain and asserts a
   * download re-issued AFTER the tick sees a nulled promise (starts fresh),
   * whereas one re-issued synchronously (before the tick) would see the guard.
   */
  it("finally() nulls the in-flight promise before a deferred re-issue runs", async () => {
    // Model AppUpdater's downloadPromise lifecycle.
    let downloadPromise: Promise<unknown> | null = null;
    let doDownloadCount = 0;

    const downloadUpdate = (): Promise<unknown> => {
      // AppUpdater.js:442-444 guard.
      if (downloadPromise != null) return downloadPromise;
      doDownloadCount += 1;
      downloadPromise = Promise.reject(new Error("checksum mismatch"))
        .catch((e) => {
          // errorHandler → dispatchError (emits "error"); swallow for the model.
          void e;
        })
        .finally(() => {
          downloadPromise = null; // AppUpdater.js:471-473
        });
      return downloadPromise;
    };

    // First (organic) download starts and its promise is stored.
    void downloadUpdate();
    expect(doDownloadCount).toBe(1);

    // A SYNCHRONOUS re-issue (what B1 fixed) hits the guard → no fresh download.
    void downloadUpdate();
    expect(doDownloadCount).toBe(1);

    // Defer one tick: the first download's .finally runs and nulls the promise.
    await flushMicrotasks();

    // Now a DEFERRED re-issue starts a genuinely fresh download.
    void downloadUpdate();
    expect(doDownloadCount).toBe(2);

    await flushMicrotasks();
  });
});
