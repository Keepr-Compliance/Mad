/**
 * BACKLOG-3784 (C12): the main-process wiring of the responsiveness tracker.
 * An EventEmitter stands in for the BrowserWindow, which emits exactly these two events.
 */
import { EventEmitter } from "events";
import {
  WindowResponsivenessTracker,
  attachResponsivenessTracking,
} from "../windowResponsivenessTracker";

function setup(dialogChoice: number) {
  let t = 0;
  const win = new EventEmitter();
  const logs: string[] = [];
  const captures: Array<{ message: string; tags: Record<string, string> }> = [];
  const actions = {
    warn: jest.fn(),
    promptUser: jest.fn(async () => dialogChoice),
    reload: jest.fn(),
    quit: jest.fn(),
  };
  const tracker = new WindowResponsivenessTracker({
    now: () => t,
    log: (l) => logs.push(l),
    capture: (message, context) => captures.push({ message, tags: context.tags }),
    getPhase: () => "storing",
  });
  attachResponsivenessTracking(win, tracker, actions);
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { win, logs, captures, actions, flush, at: (ms: number) => (t = ms) };
}

describe("BACKLOG-3784: attachResponsivenessTracking", () => {
  it("registers both listeners", () => {
    const { win } = setup(0);
    expect(win.listenerCount("responsive")).toBe(1);
    expect(win.listenerCount("unresponsive")).toBe(1);
  });

  it("unresponsive then responsive logs the duration and sends exactly one event above 5 s", async () => {
    const { win, logs, captures, flush, at } = setup(0); // Wait
    at(1_000);
    win.emit("unresponsive");
    await flush();
    at(9_000);
    win.emit("responsive");
    expect(logs).toEqual(["[Main] Window responsive again durationMs=8000 phase=storing"]);
    expect(captures).toHaveLength(1);
    expect(captures[0].tags.ended_by).toBe("responsive");
  });

  it("Reload sends one event with the duration so far, and the later responsive adds none", async () => {
    const { win, captures, actions, flush, at } = setup(1);
    at(0);
    win.emit("unresponsive");
    at(7_000);
    await flush();
    expect(captures).toHaveLength(1);
    expect(captures[0].tags).toMatchObject({ ended_by: "reload", duration_bucket: "5s_15s" });
    expect(actions.reload).toHaveBeenCalledTimes(1);
    at(8_000);
    win.emit("responsive"); // the reloaded page answers
    expect(captures).toHaveLength(1);
  });

  it("Quit sends one event before quitting", async () => {
    const { win, captures, actions, flush, at } = setup(2);
    at(0);
    win.emit("unresponsive");
    at(20_000);
    await flush();
    expect(captures).toHaveLength(1);
    expect(captures[0].tags).toMatchObject({ ended_by: "quit", duration_bucket: "15s_60s" });
    expect(actions.quit).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a Reload under 5 s", async () => {
    const { win, captures, flush, at } = setup(1);
    at(0);
    win.emit("unresponsive");
    at(3_000);
    await flush();
    expect(captures).toHaveLength(0);
  });
});
