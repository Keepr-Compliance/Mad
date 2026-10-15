/**
 * BACKLOG-3785 — every closed window freeze reaches the `renderer_freeze` reporter
 * with its duration and the phase at its start; a throwing reporter is swallowed.
 */
import { WindowResponsivenessTracker } from "../windowResponsivenessTracker";

describe("BACKLOG-3785: WindowResponsivenessTracker.onFreeze", () => {
  it("reports duration and the phase at the start, once per freeze, for responsive and flush", () => {
    let now = 0;
    let phase: string | null = null;
    const freezes: Array<[number, string | null]> = [];
    const tracker = new WindowResponsivenessTracker({
      now: () => now,
      log: () => undefined,
      capture: () => undefined,
      getPhase: () => phase,
      onFreeze: (ms, p) => freezes.push([ms, p]),
    });
    tracker.onUnresponsive();
    now = 53_000;
    phase = "post-sync";
    tracker.onResponsive();
    tracker.onResponsive(); // no open freeze: nothing
    phase = "storing:attachments";
    tracker.onUnresponsive();
    now = 80_000;
    tracker.flush("reload");
    expect(freezes).toEqual([
      [53_000, null],
      [27_000, "storing:attachments"],
    ]);
  });

  it("a throwing onFreeze never breaks the window's event handling", () => {
    let now = 0;
    const tracker = new WindowResponsivenessTracker({
      now: () => now,
      log: () => undefined,
      capture: () => undefined,
      onFreeze: () => {
        throw new Error("boom");
      },
    });
    tracker.onUnresponsive();
    now = 20_000;
    expect(tracker.onResponsive()).toBe(20_000);
  });
});
