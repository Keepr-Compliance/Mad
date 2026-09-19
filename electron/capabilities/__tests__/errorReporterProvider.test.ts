/**
 * The ErrorReporter composition seam (BACKLOG-2962, seams PR A).
 *
 * Mirrors `loggerProvider.test.ts`. The one property worth more than the
 * boilerplate is the LAST case: the options object must reach the installed
 * implementation by IDENTITY, not merely deep-equal. A forwarder that rebuilds
 * `{ tags: { ...options.tags } }` would pass a `toEqual` assertion and would
 * still be a behaviour change the day a caller passes a key this seam's types
 * do not name.
 */

import { SilentErrorReporter, type Breadcrumb, type ErrorReporter } from "../errorReporter";
import {
  getErrorReporter,
  hostErrorReporter,
  installErrorReporter,
  isErrorReporterInstalled,
  resetErrorReporter,
} from "../errorReporterProvider";

type Call = [string, ...unknown[]];

function makeRecorder(): ErrorReporter & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    captureException: (error, options) => calls.push(["captureException", error, options]),
    captureMessage: (message, options) => calls.push(["captureMessage", message, options]),
    addBreadcrumb: (breadcrumb) => calls.push(["addBreadcrumb", breadcrumb]),
    flush: (timeoutMs) => {
      calls.push(["flush", timeoutMs]);
      return Promise.resolve(true);
    },
    setUser: (user) => calls.push(["setUser", user]),
  };
}

describe("errorReporterProvider (BACKLOG-2962)", () => {
  afterEach(() => {
    installErrorReporter(makeRecorder());
  });

  it("reports NOT installed while the silent default is in force", () => {
    resetErrorReporter();
    expect(isErrorReporterInstalled()).toBe(false);
    expect(getErrorReporter()).toBeInstanceOf(SilentErrorReporter);
  });

  it("the silent default DROPS reports instead of throwing — the documented divergence", () => {
    resetErrorReporter();
    // All 35 wrapped sites are inside a `catch` or on a startup path. A throwing
    // default would escape from inside an error handler.
    expect(() => hostErrorReporter.captureException(new Error("boom"))).not.toThrow();
    expect(() => hostErrorReporter.addBreadcrumb({ category: "x" })).not.toThrow();
    expect(() => hostErrorReporter.setUser(null)).not.toThrow();
  });

  it("the silent default's flush resolves true, so `await flush()` cannot hang a shutdown", async () => {
    resetErrorReporter();
    await expect(hostErrorReporter.flush(2000)).resolves.toBe(true);
  });

  it("hostErrorReporter forwards every method", async () => {
    const recorder = makeRecorder();
    installErrorReporter(recorder);
    const error = new Error("migration failed");

    hostErrorReporter.captureException(error, {
      tags: { service: "database-service", operation: "runMigrations" },
    });
    hostErrorReporter.captureMessage("db_ready_timeout", {
      level: "warning",
      tags: { component: "startup", event: "db_ready_timeout" },
    });
    hostErrorReporter.addBreadcrumb({ category: "validation", level: "warning" });
    await hostErrorReporter.flush(2000);
    hostErrorReporter.setUser({ id: "user-1", email: undefined });

    expect(recorder.calls.map((c) => c[0])).toEqual([
      "captureException",
      "captureMessage",
      "addBreadcrumb",
      "flush",
      "setUser",
    ]);
    expect(recorder.calls[0][1]).toBe(error);
    expect(recorder.calls[3][1]).toBe(2000);
  });

  it("passes the options object through by IDENTITY, not a copy", () => {
    // A forwarder that rebuilt the object would drop any key this seam's types
    // do not name — silently, and only in production.
    const recorder = makeRecorder();
    installErrorReporter(recorder);
    const options = { tags: { service: "database-encryption", operation: "initialize" } };
    const breadcrumb: Breadcrumb = { category: "database", message: "ctx set", level: "info" };

    hostErrorReporter.captureException(new Error("x"), options);
    hostErrorReporter.addBreadcrumb(breadcrumb);

    expect(recorder.calls[0][2]).toBe(options);
    expect(recorder.calls[1][1]).toBe(breadcrumb);
  });

  it("forwards at CALL time, not at bind time", () => {
    resetErrorReporter();
    const bound = hostErrorReporter;
    const recorder = makeRecorder();
    installErrorReporter(recorder);
    bound.captureMessage("after");
    expect(recorder.calls).toEqual([["captureMessage", "after", undefined]]);
  });

  it("resetErrorReporter puts the silent default back", () => {
    installErrorReporter(makeRecorder());
    expect(isErrorReporterInstalled()).toBe(true);
    resetErrorReporter();
    expect(isErrorReporterInstalled()).toBe(false);
  });
});
