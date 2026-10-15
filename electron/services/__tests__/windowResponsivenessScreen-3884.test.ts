/**
 * @jest-environment node
 *
 * BACKLOG-3884 — the "Window responsive again" line (every freeze, any length)
 * names the screen the freeze started on.
 */
import { WindowResponsivenessTracker } from "../windowResponsivenessTracker";

it("names the screen at the START of the freeze, for a 2 s freeze", () => {
  const lines: string[] = [];
  let now = 0;
  let screen = "dashboard+TransactionDetails";
  const t = new WindowResponsivenessTracker({
    now: () => now,
    log: (l) => lines.push(l),
    capture: () => undefined,
    getScreen: () => screen,
  });
  t.onUnresponsive();
  screen = "dashboard";
  now = 2_000;
  t.onResponsive();
  expect(lines).toEqual([
    "[Main] Window responsive again durationMs=2000 phase=none screen=dashboard+TransactionDetails",
  ]);
});
