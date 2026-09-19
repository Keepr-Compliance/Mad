/**
 * The Windows composition seam (BACKLOG-2962, seams PR B).
 *
 * Mirrors `appPathsProvider.test.ts`, with one deliberate difference asserted
 * rather than described: this default is SILENT. Both call sites
 * (`initializationBroadcaster.broadcast`, `reviewStateService`'s
 * `broadcastReviewQueueChanged`) already wrap the call in a `catch` that treats
 * undelivered as ordinary, so a throwing default would land inside those
 * handlers, be swallowed, and be indistinguishable from silence while being
 * harder to read. What notices a missing install is `isWindowsInstalled()`,
 * which both layers of the composition-root guard read.
 */

import { SilentWindows, type Windows } from "../windows";
import {
  getWindows,
  hostWindows,
  installWindows,
  isWindowsInstalled,
  resetWindows,
} from "../windowsProvider";

/** A Windows that records every (channel, payload) it is asked to deliver. */
function recorder(): { windows: Windows; sent: Array<[string, unknown]> } {
  const sent: Array<[string, unknown]> = [];
  return {
    sent,
    windows: {
      broadcast: (channel, payload) => {
        sent.push([channel, payload]);
      },
    },
  };
}

describe("windowsProvider (BACKLOG-2962)", () => {
  afterEach(() => {
    // tests/setup.js installed one for this file; put a real one back so no
    // later case in this file inherits the silent default.
    installWindows(recorder().windows);
  });

  it("reports NOT installed while the silent default is in force", () => {
    resetWindows();
    expect(isWindowsInstalled()).toBe(false);
    expect(getWindows()).toBeInstanceOf(SilentWindows);
  });

  it("the default DELIVERS NOTHING and does not throw — the deliberate divergence from AppPaths", () => {
    // If this threw, it would throw from inside `reviewStateService`'s
    // `catch {}` and `initializationBroadcaster`'s `catch (err)`. Both would
    // swallow it, so the observable behaviour would be identical to silence —
    // with a misleading log line in one of them.
    resetWindows();
    expect(() => hostWindows.broadcast("system:init-stage", { stage: "idle" })).not.toThrow();
  });

  it("hostWindows forwards channel and payload to whatever is installed", () => {
    const { windows, sent } = recorder();
    installWindows(windows);
    const payload = { stage: "db-ready" };
    hostWindows.broadcast("system:init-stage", payload);
    expect(sent).toEqual([["system:init-stage", payload]]);
    // BY REFERENCE, not a copy: an implementation that rebuilt the payload could
    // drop a key and every existing assertion would still pass.
    expect(sent[0][1]).toBe(payload);
  });

  it("forwards at CALL time, not at bind time", () => {
    // `initializationBroadcaster` and `reviewStateService` both bind
    // `hostWindows` when their module loads, which is before any shell has
    // installed anything.
    resetWindows();
    const bound = hostWindows;
    const { windows, sent } = recorder();
    installWindows(windows);
    bound.broadcast("review:queue-changed", { transactionId: "t1" });
    expect(sent).toHaveLength(1);
  });

  it("a throwing implementation propagates to the caller, which is what the call sites' catch is for", () => {
    // The Electron adapter does NOT catch: a `send` that throws part-way must
    // reach the caller's own handler, because the two callers handle it
    // differently (one logs at debug, one swallows).
    installWindows({
      broadcast: () => {
        throw new Error("Object has been destroyed");
      },
    });
    expect(() => hostWindows.broadcast("c", 1)).toThrow("Object has been destroyed");
  });

  it("installing twice replaces the implementation", () => {
    const first = recorder();
    const second = recorder();
    installWindows(first.windows);
    installWindows(second.windows);
    hostWindows.broadcast("c", 1);
    expect(first.sent).toHaveLength(0);
    expect(second.sent).toHaveLength(1);
  });

  it("resetWindows puts the silent default back", () => {
    installWindows(recorder().windows);
    expect(isWindowsInstalled()).toBe(true);
    resetWindows();
    expect(isWindowsInstalled()).toBe(false);
  });
});
