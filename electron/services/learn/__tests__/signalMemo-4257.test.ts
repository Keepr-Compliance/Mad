/**
 * @jest-environment node
 *
 * BACKLOG-4257 PR B (SR R4) — the per-user signal memo: single-flight, a complete
 * result reused within the TTL, newest entry per user only, never a rejected or
 * incomplete pass.
 */
import { createSignalMemo, SIGNAL_MEMO_TTL_MS } from "../signalMemo";
import type { SignalScore } from "../signalScoring";
import { syntheticSignals } from "../../__tests__/helpers/pilotFixtureScore-4257";

const K = { runId: "run-1", latestAnswerAt: "2026-11-01T00:00:00.000Z" };

function setup() {
  let clock = 1_000;
  const memo = createSignalMemo({ now: () => clock });
  let passes = 0;
  const pass = (s: SignalScore = syntheticSignals(1)) => () => {
    passes += 1;
    return Promise.resolve(s);
  };
  return { memo, pass, passes: () => passes, tick: (ms: number) => (clock += ms) };
}

describe("signal memo (R4)", () => {
  it("single-flight: two calls while one pass runs share it", async () => {
    const { memo } = setup();
    let release!: (s: SignalScore) => void;
    const p = jest.fn(() => new Promise<SignalScore>((res) => (release = res)));
    const a = memo.get("u", K, p);
    const b = memo.get("u", K, p);
    expect(a).toBe(b);
    await Promise.resolve();
    expect(p).toHaveBeenCalledTimes(1);
    release(syntheticSignals(1));
    expect(await a).toBe(await b);
  });

  it("a complete result is reused within the TTL, a new pass after it", async () => {
    const t = setup();
    await t.memo.get("u", K, t.pass());
    t.tick(SIGNAL_MEMO_TTL_MS - 1);
    await t.memo.get("u", K, t.pass());
    expect(t.passes()).toBe(1);
    t.tick(1);
    await t.memo.get("u", K, t.pass());
    expect(t.passes()).toBe(2);
  });

  it("a new latest answer or a new run -> a new pass", async () => {
    const t = setup();
    await t.memo.get("u", K, t.pass());
    await t.memo.get("u", { ...K, latestAnswerAt: "2026-11-02T00:00:00.000Z" }, t.pass());
    expect(t.passes()).toBe(2);
    await t.memo.get("u", { ...K, latestAnswerAt: "2026-11-02T00:00:00.000Z", runId: "run-2" }, t.pass());
    expect(t.passes()).toBe(3);
    await t.memo.get("u", { runId: "run-2", latestAnswerAt: null }, t.pass());
    expect(t.passes()).toBe(4);
  });

  it("newest entry per user only: the old key is not kept", async () => {
    const t = setup();
    await t.memo.get("u", K, t.pass());
    await t.memo.get("u", { ...K, runId: "run-2" }, t.pass());
    await t.memo.get("u", K, t.pass());
    expect(t.passes()).toBe(3);
  });

  it("per user: another user's pass is never shared", async () => {
    const t = setup();
    await t.memo.get("u", K, t.pass());
    await t.memo.get("v", K, t.pass());
    expect(t.passes()).toBe(2);
  });

  it("a rejected pass is never reused", async () => {
    const t = setup();
    await expect(t.memo.get("u", K, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await t.memo.get("u", K, t.pass());
    expect(t.passes()).toBe(1);
  });

  it("an incomplete result is never reused", async () => {
    const t = setup();
    const partial = await t.memo.get("u", K, t.pass(syntheticSignals(1, { complete: false, stoppedBy: "time" })));
    expect(partial.complete).toBe(false);
    await t.memo.get("u", K, t.pass());
    expect(t.passes()).toBe(2);
  });
});
