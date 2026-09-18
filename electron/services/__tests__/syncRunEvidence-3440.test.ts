/**
 * BACKLOG-3440 — A RUN THAT NEVER ENDS STILL LEAVES EVIDENCE.
 *
 * On 2026-09-16 two users each lost about three hours to an iPhone sync that never
 * completed. One left a row reading `cancelled` after 181.7 minutes. The other left NO
 * ROW AT ALL — not a failure row, nothing — because `sync_outcomes` recorded a run when
 * it FINISHED one of its known ways, and that run had no finish.
 *
 * THE DEFECT IS AN ABSENCE OF DATA, SO THE CONTROL IS AN ABSENCE MADE PRESENT. A suite
 * that only exercises clean completion cannot distinguish this fix from the behaviour it
 * replaces: every such test passed before it and passes after it. The load-bearing test
 * in this file is "the run is killed and never ends" — everything else supports it.
 *
 * WIRING, NOT STUBS. Every test drives a `SyncTimeline` constructed the way production
 * constructs it — no reporter injected — so the assertions run through the real default
 * sink into `syncOutcomeSupabase`, with only the Supabase client itself mocked. A suite
 * that injected its own sink would pass against a module wired to nothing, which is the
 * exact failure BACKLOG-2914 recovered from.
 *
 * WHAT THIS FILE CANNOT DO. "Kill the app mid-sync" here means "stop calling the
 * timeline", which is what a killed process looks like from inside this module. It is
 * NOT the same as SIGKILL against a packaged build with a real network, and it is named
 * as a jest control so nobody records a green run here as having proved the real thing.
 * That remains founder QA.
 */

import supabaseService from "../supabaseService";
import {
  SyncTimeline,
  SYNC_OUTCOME_SOURCE,
  SYNC_RUN_HEARTBEAT_MS,
} from "../syncTimeline";
import { buildSyncOutcomeRow, buildSyncRunProgressRow } from "../syncOutcomeSupabase";
import type { SyncOutcomeRow } from "../syncTimeline";

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: jest.fn() },
}));

const getClient = (supabaseService as unknown as { getClient: jest.Mock }).getClient;

type Payload = Record<string, unknown>;

let upsert: jest.Mock;
let update: jest.Mock;
let eq: jest.Mock;
let select: jest.Mock;
let from: jest.Mock;

/**
 * A PostgREST-shaped builder: awaitable, and chainable with `.select()` / `.eq()`.
 *
 * The `select` spy is the point. A mock that simply resolved could not tell whether the
 * code chained `.select()` on to "confirm the write" — it would pass either way, which
 * is how a control comes to prove nothing.
 */
function builder(): Promise<{ error: null }> & { select: jest.Mock; eq: jest.Mock } {
  const p = Promise.resolve({ error: null }) as Promise<{ error: null }> & {
    select: jest.Mock;
    eq: jest.Mock;
  };
  p.select = select;
  p.eq = eq;
  return p;
}

/** Every write the module made, in order, with the verb that made it. */
function writes(): Array<{ verb: "upsert" | "update"; payload: Payload; options?: Payload }> {
  const out: Array<{ verb: "upsert" | "update"; payload: Payload; options?: Payload }> = [];
  for (const call of upsert.mock.calls) {
    out.push({ verb: "upsert", payload: call[0] as Payload, options: call[1] as Payload });
  }
  for (const call of update.mock.calls) {
    out.push({ verb: "update", payload: call[0] as Payload });
  }
  return out;
}

function mockClient(userId: string | null = "user-3440") {
  select = jest.fn(() => builder());
  eq = jest.fn(() => builder());
  upsert = jest.fn(() => builder());
  update = jest.fn(() => builder());
  from = jest.fn(() => ({ upsert, update, insert: jest.fn() }));
  return {
    auth: {
      getSession: jest
        .fn()
        .mockResolvedValue({ data: { session: userId ? { user: { id: userId } } : null } }),
    },
    from,
  };
}

/**
 * Let every fire-and-forget write run to completion.
 *
 * A microtask drain rather than `setTimeout(r, 0)`: this suite runs under fake timers,
 * where a macrotask never fires on its own, and a flush that silently never ran would
 * make every assertion below vacuous.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const RUN_START = Date.UTC(2026, 8, 16, 9, 0, 0);

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(RUN_START);
  getClient.mockReturnValue(mockClient());
});

afterEach(() => {
  jest.useRealTimers();
});

/** Production wiring: no reporter injected, so the real default sinks are used. */
function productionTimeline() {
  return new SyncTimeline({ sink: () => {} });
}

// ---------------------------------------------------------------------------
// CONTROL 1 — the row exists before the run can fail
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: the run is in the corpus before anything can go wrong", () => {
  it("THE CONTROL — beginSync alone writes a row, and it says the run is RUNNING", async () => {
    const timeline = productionTimeline();
    timeline.beginSync({ platform: "darwin" });
    await flush();

    // Delete the `this.runReporter.start(row)` call in `beginSync` and this reds: there
    // is no write at all, which is precisely the state the second 2026-09-16 user was
    // left in.
    expect(from).toHaveBeenCalledWith("sync_outcomes");
    expect(upsert).toHaveBeenCalledTimes(1);
    const payload = upsert.mock.calls[0][0] as Payload;
    expect(payload.outcome).toBe("running");
    expect(payload.source).toBe(SYNC_OUTCOME_SOURCE);
    expect(payload.started_at).toBe(new Date(RUN_START).toISOString());
    expect(typeof payload.id).toBe("string");
    expect((payload.id as string).length).toBeGreaterThan(0);
  });

  it("the start write cannot revert a run that already finished", async () => {
    // A sync can fail in its first milliseconds — a pre-flight disk or driver check —
    // and land its terminal write before the start write's round trip completes. The
    // start write therefore says DO NOTHING on conflict. Drop `ignoreDuplicates` and a
    // late start write becomes an update that rewrites `outcome` back to `running`,
    // permanently, on a run that succeeded.
    const timeline = productionTimeline();
    timeline.beginSync();
    await flush();

    expect(upsert.mock.calls[0][1]).toEqual({ onConflict: "id", ignoreDuplicates: true });
  });

  it("every write in one run carries the SAME id, and two runs carry different ids", async () => {
    const timeline = productionTimeline();
    timeline.beginSync();
    timeline.enter("backup:transferring");
    timeline.endSync("complete");
    await flush();

    const ids = writes().map((w) => w.payload.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    const firstRunId = ids[0];

    upsert.mockClear();
    update.mockClear();
    timeline.beginSync();
    await flush();
    expect(upsert.mock.calls[0][0].id).not.toBe(firstRunId);
  });
});

// ---------------------------------------------------------------------------
// CONTROL 2 — THE ONE THAT MATTERS. The app dies mid-sync.
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: a run that is killed mid-transfer leaves a row describing itself", () => {
  /**
   * The traced producer: `before-quit` kills the backup process and nulls the
   * orchestrator, and the terminal write is an un-flushed fire-and-forget insert that
   * the exiting process never completes. From inside this module a killed app is
   * indistinguishable from "nothing else ever calls the timeline", which is what this
   * test does.
   */
  it("THE CONTROL — never calling endSync still leaves a row, and it says RUNNING", async () => {
    const timeline = productionTimeline();
    timeline.beginSync({ platform: "darwin" });
    timeline.setContext({ deviceModel: "iPhone18,2", priorBackup: "none" });
    timeline.enter("backup:transferring");
    timeline.recordBytesTransferred(2_100_000_000);
    await flush();

    // 40 minutes pass, the user quits the app, and the sync is simply gone.
    jest.advanceTimersByTime(40 * 60_000);
    await flush();

    const all = writes();
    expect(all.length).toBeGreaterThan(0);

    // The row exists and it has never been told the run finished.
    const start = all.find((w) => w.verb === "upsert");
    expect(start).toBeDefined();
    expect(start!.payload.outcome).toBe("running");

    // NO terminal write happened — this is the distinguishing half. A run that
    // completes cleanly produces one (see the next test); this one does not.
    expect(
      all.filter((w) => w.verb === "upsert" && w.payload.outcome !== "running"),
    ).toHaveLength(0);

    // And the row says where it got to, which is what makes it diagnosable rather than
    // merely present.
    const last = all[all.length - 1];
    expect(last.payload.last_phase).toBe("backup:transferring");
    expect(last.payload.bytes_transferred).toBe(2_100_000_000);
    expect(last.payload.prior_backup).toBe("none");
    expect(last.payload.device_model).toBe("iPhone18,2");
    expect(last.payload.started_at).toBe(new Date(RUN_START).toISOString());
  });

  it("DISCRIMINATOR — a run that completes cleanly does NOT look like that", async () => {
    // Without this, the test above would pass on code that marks every run `running`
    // forever. The two must be distinguishable, and this is the pair that proves it.
    const timeline = productionTimeline();
    timeline.beginSync({ platform: "darwin" });
    timeline.enter("backup:transferring");
    timeline.endSync("complete", { messagesExtracted: 663_722 });
    await flush();

    const terminal = writes().filter((w) => w.verb === "upsert" && w.payload.outcome !== "running");
    expect(terminal).toHaveLength(1);
    expect(terminal[0].payload.outcome).toBe("complete");
    expect(terminal[0].payload.messages_extracted).toBe(663_722);
  });
});

// ---------------------------------------------------------------------------
// CONTROL 3 — alive and moving, alive and stalled, gone
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: the byte clock separates a slow transfer from a dead one", () => {
  it("THE CONTROL — repeated identical byte counts do NOT advance the last-increase time", async () => {
    // Change `bytes > previous` to `bytes >= previous` in `recordBytesTransferred` and
    // this reds. That is the whole instrument: with `>=`, a transfer that has stopped
    // dead refreshes its own timestamp on every repeated sample and reads as healthy.
    const timeline = productionTimeline();
    timeline.beginSync();
    timeline.enter("backup:transferring");

    jest.advanceTimersByTime(60_000);
    timeline.recordBytesTransferred(5_000_000);
    const firstIncrease = new Date(RUN_START + 60_000).toISOString();

    // Ten more minutes of the process chattering away and moving nothing.
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(120_000);
      timeline.recordBytesTransferred(5_000_000);
    }
    await flush();

    const heartbeats = writes().filter((w) => w.verb === "update");
    expect(heartbeats.length).toBeGreaterThan(0);
    const last = heartbeats[heartbeats.length - 1];

    // Frozen...
    expect(last.payload.bytes_last_increased_at).toBe(firstIncrease);
    // ...while the row itself kept being refreshed. THAT PAIR IS THE DIAGNOSIS: alive,
    // and moving nothing.
    expect(last.payload.updated_at).not.toBe(firstIncrease);
    expect(new Date(last.payload.updated_at as string).getTime()).toBeGreaterThan(
      new Date(firstIncrease).getTime(),
    );
  });

  it("a genuine increase DOES advance it", async () => {
    const timeline = productionTimeline();
    timeline.beginSync();
    jest.advanceTimersByTime(60_000);
    timeline.recordBytesTransferred(5_000_000);

    jest.advanceTimersByTime(60_000);
    timeline.recordBytesTransferred(9_000_000);
    await flush();
    update.mockClear();

    jest.advanceTimersByTime(SYNC_RUN_HEARTBEAT_MS);
    await flush();

    const last = update.mock.calls[update.mock.calls.length - 1][0] as Payload;
    expect(last.bytes_transferred).toBe(9_000_000);
    expect(last.bytes_last_increased_at).toBe(new Date(RUN_START + 120_000).toISOString());
  });

  it("a count that goes BACKWARDS cannot rewind the mark", async () => {
    // `backupService` composes the emitted figure as completed-files plus the current
    // file's bytes, and the second part resets per file — its own docblock records that
    // as a known trap. A dip must not read as a smaller transfer.
    const timeline = productionTimeline();
    timeline.beginSync();
    timeline.recordBytesTransferred(9_000_000);
    timeline.recordBytesTransferred(4_000_000);
    timeline.endSync("error");
    await flush();

    const terminal = writes().filter((w) => w.verb === "upsert" && w.payload.outcome === "error");
    expect(terminal[0].payload.bytes_transferred).toBe(9_000_000);
  });
});

// ---------------------------------------------------------------------------
// CONTROL 4 — a late heartbeat cannot un-finish a finished run
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: the heartbeat can never overwrite an outcome", () => {
  /**
   * THE MOST LIKELY WRONG IMPLEMENTATION, and it would have looked entirely shipped.
   * Every write here is fire-and-forget with no ordering guarantee. A heartbeat still in
   * flight when the terminal write lands would, if it carried `outcome`, leave a
   * COMPLETED sync reading `running` forever — a new false signal produced by the
   * instrument built to remove false signals.
   */
  it("THE CONTROL — the heartbeat payload has no `outcome` key at all", () => {
    const row: SyncOutcomeRow = {
      // pii-allow-uuid: invented sync run id, typed by hand for this fixture
      runId: "1f0c2b54-8d3a-4a71-9c22-6d7e5f0a1b33",
      startedAt: RUN_START,
      source: SYNC_OUTCOME_SOURCE,
      outcome: "running",
      elapsedMs: 600_000,
      phases: [{ phase: "backup:transferring", elapsedMs: 540_000 }],
      fields: { lastPhase: "backup:transferring", bytesTransferred: 12_345 },
    };

    // Make `buildSyncRunProgressRow` return the full row and this reds.
    expect(buildSyncRunProgressRow(row, "u")).not.toHaveProperty("outcome");
    // The fixture really could have leaked one: the terminal builder, same input, does.
    expect(buildSyncOutcomeRow(row, "u")).toHaveProperty("outcome", "running");
    // ...and the heartbeat still carries everything a live run is worth knowing.
    expect(buildSyncRunProgressRow(row, "u")).toMatchObject({
      // pii-allow-uuid: the same invented run id as the fixture above
      id: "1f0c2b54-8d3a-4a71-9c22-6d7e5f0a1b33",
      last_phase: "backup:transferring",
      bytes_transferred: 12_345,
    });
  });

  it("THE CONTROL — no heartbeat is written after the run has ended", async () => {
    // WHAT THIS CONTROL CAN AND CANNOT SEE, MEASURED RATHER THAN ASSUMED. Three
    // independent things stop a write after the run has ended, and NO SINGLE removal
    // reds this test:
    //
    //   1. `endSync` clears the interval          — removed alone: still green
    //   2. `flushHeartbeat` returns on a null run  — removed alone: still green
    //   3. `writeSyncRun` returns on an empty id   — the last line of defence
    //
    // Removing 1 and 2 together is still green. All three must go before this fails.
    // Written down because the first draft of this comment credited guard 2, and a
    // control that names the wrong line is how a real defect gets shipped past it. The
    // invariant is worth defending three times — a completed sync reverted to `running`
    // would be permanent and silent — but nobody should read a green run here as proof
    // that any one of the three is present. The next test covers guard 1 on its own.
    const timeline = productionTimeline();
    timeline.beginSync();
    jest.advanceTimersByTime(SYNC_RUN_HEARTBEAT_MS);
    await flush();
    expect(update).toHaveBeenCalledTimes(1); // the timer really does fire

    timeline.endSync("complete");
    await flush();
    update.mockClear();

    jest.advanceTimersByTime(SYNC_RUN_HEARTBEAT_MS * 5);
    await flush();
    expect(update).not.toHaveBeenCalled();
  });

  it("THE CONTROL — the timer itself is cleared, not merely rendered harmless", async () => {
    // This is what `stopHeartbeat()` is for, and the test above proved it is NOT what
    // keeps a finished row clean. A two-minute interval left running for the life of the
    // process is a leak in the main process of an app people leave open all day, and one
    // per sync accumulates. Remove `stopHeartbeat()` from `endSync` and this reds.
    const timeline = productionTimeline();
    const before = jest.getTimerCount();
    timeline.beginSync();
    expect(jest.getTimerCount()).toBe(before + 1);

    timeline.endSync("complete");
    expect(jest.getTimerCount()).toBe(before);
  });

  it("every heartbeat is addressed to its own run's row", async () => {
    const timeline = productionTimeline();
    timeline.beginSync();
    await flush();
    const runId = upsert.mock.calls[0][0].id;

    jest.advanceTimersByTime(SYNC_RUN_HEARTBEAT_MS);
    await flush();

    expect(eq).toHaveBeenCalledWith("id", runId);
  });
});

// ---------------------------------------------------------------------------
// CONTROL 5 — which act ended the run
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: `ended_by` survives even when the run never ends", () => {
  it("THE CONTROL — noteEndedBy writes immediately, without waiting for a terminal row", async () => {
    // Make `noteEndedBy` a no-op and this reds. The immediate write is what makes the
    // restart case recordable at all: a restart-while-running is followed within
    // milliseconds by a new `beginSync` that clears the context, and the abandoned run's
    // own terminal write is suppressed by the orchestrator's `isRunning` guard.
    const timeline = productionTimeline();
    timeline.beginSync();
    timeline.enter("backup:transferring");
    update.mockClear();

    timeline.noteEndedBy("restart-while-running");
    await flush();

    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0][0] as Payload).ended_by).toBe("restart-while-running");
  });

  it("Cancel and Try-Again are different values, not the same row", async () => {
    // Collapse both callers to one value and this reds. "I cancelled it" and "it hung so
    // I hit Try Again" are different reports from a user, and until now they produced
    // identical rows — which is why the founder had to ask the two users by hand.
    const cancelled = productionTimeline();
    cancelled.beginSync();
    cancelled.noteEndedBy("user-cancel");
    cancelled.endSync("cancelled");
    await flush();
    const a = writes().filter((w) => w.verb === "upsert" && w.payload.outcome === "cancelled");
    expect(a[0].payload.ended_by).toBe("user-cancel");

    upsert.mockClear();
    update.mockClear();
    const restarted = productionTimeline();
    restarted.beginSync();
    restarted.noteEndedBy("restart-while-running");
    restarted.endSync("cancelled");
    await flush();
    const b = writes().filter((w) => w.verb === "upsert" && w.payload.outcome === "cancelled");
    expect(b[0].payload.ended_by).toBe("restart-while-running");
    expect(b[0].payload.ended_by).not.toBe(a[0].payload.ended_by);
  });
});

// ---------------------------------------------------------------------------
// The rules the rest of the module already lives by, extended to the new writes
// ---------------------------------------------------------------------------

describe("BACKLOG-3440: the new writes obey the old guarantees", () => {
  it("a signed-out user writes nothing at all, rather than a row RLS would refuse", async () => {
    getClient.mockReturnValue(mockClient(null));
    const timeline = productionTimeline();
    timeline.beginSync();
    jest.advanceTimersByTime(SYNC_RUN_HEARTBEAT_MS);
    timeline.endSync("complete");
    await flush();

    expect(upsert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("a failing start write never surfaces as an unhandled rejection", async () => {
    const rejection = jest.fn();
    process.on("unhandledRejection", rejection);
    getClient.mockReturnValue({
      auth: {
        getSession: jest.fn().mockResolvedValue({ data: { session: { user: { id: "u" } } } }),
      },
      from: () => ({ upsert: jest.fn().mockRejectedValue(new Error("network unreachable")) }),
    });

    const timeline = productionTimeline();
    expect(() => timeline.beginSync()).not.toThrow();
    await flush();
    expect(rejection).not.toHaveBeenCalled();
    process.off("unhandledRejection", rejection);
  });

  it("NO write ever asks the database to hand the row back", async () => {
    // A `.select()` chained on to "confirm the write" is a separate READ that a mocked
    // client cannot distinguish from a success — and against the live engine it changes
    // what RLS has to permit. Measured while designing the migration: with no own-rows
    // SELECT policy, the heartbeat affected zero rows silently and the terminal upsert
    // failed outright with 42501.
    const timeline = productionTimeline();
    timeline.beginSync();
    jest.advanceTimersByTime(SYNC_RUN_HEARTBEAT_MS);
    timeline.endSync("error");
    await flush();

    // The builder this mock returns DOES expose `.select()`, so the code could have
    // called it and this test could have failed. It did not.
    expect(select).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });

  it("a timeline with an injected reporter does NOT reach for a Supabase client", async () => {
    // ~40 suites inject a reporter to say "do not touch the network from this timeline".
    // Defaulting the live-run sink unconditionally would have re-opened that door behind
    // their backs — one start write per sync plus one every two minutes.
    const injected = new SyncTimeline({ sink: () => {}, reporter: () => {} });
    injected.beginSync();
    jest.advanceTimersByTime(SYNC_RUN_HEARTBEAT_MS * 3);
    injected.endSync("complete");
    await flush();

    expect(getClient).not.toHaveBeenCalled();
  });
});
