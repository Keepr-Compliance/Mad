/**
 * Live A/B (2026-10-05, Step A): in a hidden tab Chrome clamps the page's
 * timers to about once a minute, so each 250 ms wait of a Sync took a minute.
 * While a Sync runs, each wait is one message to the service worker, which
 * answers after its own (unthrottled) timer. The page's timer stays the
 * fallback when the worker is gone.
 *
 * A fake clock: the PAGE timer is throttled (each local wait takes 60 s of
 * wall time); the WORKER answers after the asked time.
 *
 * Mutations (each red): waits not sent to the worker; no fallback when the
 * worker never answers; still asking after stop(); no give-up after
 * repeated failures.
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports */
const job = require("../../chrome-extension/job.js") as {
  makePacedSleep: (io: { send: (ms: number) => Promise<boolean>; localSleep: (ms: number) => Promise<void>; now: () => number }) => {
    sleep: (ms: number) => Promise<void>;
    stop: () => void;
    stats: () => { paced: number; fallbacks: number; askedMs: number; tookMs: number };
  };
  PACED_MAX_FAILURES: number;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** A tiny event loop over a virtual clock: timers fire in time order. */
function world() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const at = (ms: number, fn: () => void) => timers.push({ at: now + ms, fn });
  async function run(untilMs: number) {
    for (;;) {
      await Promise.resolve();
      await Promise.resolve();
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > untilMs) { now = untilMs; return; }
      timers.shift();
      now = next.at;
      next.fn();
    }
  }
  return { now: () => now, at, run };
}

describe("paced waits: the worker's timer while a Sync runs (Step A)", () => {
  it("a paced wait resolves on time while the throttled page timer would take a minute", async () => {
    const w = world();
    const sent: number[] = [];
    const pacer = job.makePacedSleep({
      now: w.now,
      // The hidden tab's own timer: a minute, whatever was asked.
      localSleep: () => new Promise((r) => w.at(60_000, () => r())),
      send: (ms) => { sent.push(ms); return new Promise((r) => w.at(ms, () => r(true))); },
    });
    let doneAt = -1;
    void (async () => {
      for (let i = 0; i < 10; i++) await pacer.sleep(250);
      doneAt = w.now();
    })();
    await w.run(10 * 60_000);
    expect(doneAt).toBe(2500); // 10 × 250 ms, not 10 minutes
    expect(sent).toEqual(Array(10).fill(250));
    expect(pacer.stats()).toMatchObject({ paced: 10, fallbacks: 0, askedMs: 2500, tookMs: 2500 });
  });

  it("the worker gone (no answer, or a failed message): the page timer ends the wait; after repeated failures it stops asking", async () => {
    const w = world();
    const sent: number[] = [];
    const pacer = job.makePacedSleep({
      now: w.now,
      localSleep: (ms) => new Promise((r) => w.at(ms, () => r())),
      send: (ms) => { sent.push(ms); return new Promise(() => undefined); }, // never answers
    });
    let doneAt = -1;
    void pacer.sleep(250).then(() => (doneAt = w.now()));
    await w.run(10_000);
    expect(doneAt).toBe(2 * 250 + 1000); // 2 × N + grace
    for (let i = 1; i < job.PACED_MAX_FAILURES + 2; i++) {
      void pacer.sleep(250);
      await w.run(w.now() + 10_000);
    }
    expect(sent).toHaveLength(job.PACED_MAX_FAILURES);
    expect(pacer.stats().fallbacks).toBe(job.PACED_MAX_FAILURES);

    const failed = job.makePacedSleep({ now: w.now, localSleep: (ms) => new Promise((r) => w.at(ms, () => r())), send: () => Promise.resolve(false) });
    const start = w.now();
    let end = -1;
    void failed.sleep(250).then(() => (end = w.now()));
    await w.run(start + 10_000);
    expect(end - start).toBe(250); // the asked time, on the page timer
  });

  it("after the run ends (stop): no message is sent; waits use the page timer", async () => {
    const w = world();
    const sent: number[] = [];
    const pacer = job.makePacedSleep({
      now: w.now,
      localSleep: (ms) => new Promise((r) => w.at(ms, () => r())),
      send: (ms) => { sent.push(ms); return new Promise((r) => w.at(ms, () => r(true))); },
    });
    void pacer.sleep(100);
    await w.run(1000);
    pacer.stop();
    let done = false;
    void pacer.sleep(100).then(() => (done = true));
    await w.run(2000);
    expect(done).toBe(true);
    expect(sent).toEqual([100]);
  });

  it("the content script uses the pacer only inside a run (created in start, stopped in finally)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require("fs") as typeof import("fs")).readFileSync(require("path").join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");
    const startFn = src.slice(src.indexOf("  async function start(jobId) {"));
    expect(startFn.indexOf("pacer = makePacedSleep(")).toBeGreaterThan(0);
    expect(startFn.indexOf("pacer.stop();")).toBeGreaterThan(startFn.indexOf("} finally {"));
    expect(src).toMatch(/function sleep\(ms\) \{\s*return pacer \? pacer\.sleep\(ms\) : localSleep\(ms\);/);
  });
});
