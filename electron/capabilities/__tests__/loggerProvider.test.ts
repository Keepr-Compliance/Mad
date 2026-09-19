/**
 * The Logger composition seam (BACKLOG-2962, seams PR A).
 *
 * Mirrors `secretStoreProvider.test.ts`, because the seam is the same shape and
 * the same traps apply — call-time forwarding, a default that must be
 * distinguishable from a real implementation, and an `isInstalled()` predicate
 * the composition-root guard reads.
 *
 * The one place it deliberately DIFFERS from the SecretStore seam is the
 * default's behaviour, and that difference is asserted here rather than left in
 * prose: `UnavailableSecretStore` throws, `SilentLogger` does not. See
 * `electron/capabilities/logger.ts` for why (every wrapped call site in
 * `databaseService` and `initializationBroadcaster` is inside a `catch`; a
 * throwing logger would convert handled failures into escaped ones).
 */

import { SilentLogger, type Logger } from "../logger";
import {
  getLogger,
  hostLogger,
  installLogger,
  isLoggerInstalled,
  resetLogger,
} from "../loggerProvider";

/** A Logger that records every call verbatim, tail arguments included. */
function makeRecorder(): Logger & { calls: Array<[string, string, unknown[]]> } {
  const calls: Array<[string, string, unknown[]]> = [];
  return {
    calls,
    debug: (message: string, ...args: unknown[]) => calls.push(["debug", message, args]),
    info: (message: string, ...args: unknown[]) => calls.push(["info", message, args]),
    warn: (message: string, ...args: unknown[]) => calls.push(["warn", message, args]),
    error: (message: string, ...args: unknown[]) => calls.push(["error", message, args]),
  };
}

describe("loggerProvider (BACKLOG-2962)", () => {
  afterEach(() => {
    // tests/setup.js installed one for this file; put a real one back so no
    // later suite in this file inherits an uninstalled provider.
    installLogger(makeRecorder());
  });

  it("reports NOT installed while the silent default is in force", () => {
    resetLogger();
    expect(isLoggerInstalled()).toBe(false);
    expect(getLogger()).toBeInstanceOf(SilentLogger);
  });

  it("the silent default DROPS calls instead of throwing — the documented divergence from SecretStore", () => {
    resetLogger();
    // If this ever becomes a throw, every `catch` block that logs in
    // databaseService.ts and initializationBroadcaster.ts starts re-throwing
    // from inside its own error handler. That is the reason for the divergence,
    // so it is pinned rather than described.
    expect(() => hostLogger.error("anything", { detail: 1 })).not.toThrow();
    expect(() => hostLogger.info("anything")).not.toThrow();
  });

  it("hostLogger forwards to whatever is installed, message AND tail", () => {
    const recorder = makeRecorder();
    installLogger(recorder);

    hostLogger.info("plain");
    hostLogger.error("[DatabaseService] Migration FAILED:", "disk full");
    hostLogger.warn("two", "extra", 42);
    hostLogger.debug("quiet");

    expect(recorder.calls).toEqual([
      ["info", "plain", []],
      ["error", "[DatabaseService] Migration FAILED:", ["disk full"]],
      ["warn", "two", ["extra", 42]],
      ["debug", "quiet", []],
    ]);
  });

  it("forwards at CALL time, not at bind time", () => {
    // A consumer singleton binds `hostLogger` when its module loads, which for
    // `logService` is long before any shell installs anything.
    resetLogger();
    const bound = hostLogger; // bound while the silent default is installed
    const recorder = makeRecorder();
    installLogger(recorder);
    bound.info("after");
    expect(recorder.calls).toEqual([["info", "after", []]]);
  });

  it("installing twice replaces the implementation", () => {
    const first = makeRecorder();
    const second = makeRecorder();
    installLogger(first);
    installLogger(second);
    hostLogger.info("x");
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([["info", "x", []]]);
  });

  it("resetLogger puts the silent default back", () => {
    installLogger(makeRecorder());
    expect(isLoggerInstalled()).toBe(true);
    resetLogger();
    expect(isLoggerInstalled()).toBe(false);
  });

  it("isLoggerInstalled answers about identity, not about behaviour", () => {
    // A plain object with the four methods is a valid Logger — the predicate
    // must not require a class, only that the silent default is no longer in
    // force.
    resetLogger();
    installLogger({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
    expect(isLoggerInstalled()).toBe(true);
  });
});
