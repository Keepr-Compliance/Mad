/**
 * @jest-environment node
 */
/**
 * BACKLOG-3671 P2 — Google Messages Syncs in the sync_outcomes corpus.
 *
 * Mutation controls (each turns a test red):
 *   T1 the builder passing an unknown key / a string / an array through   → "builder"
 *   T2 a non-finite or negative number kept, or no clamp                  → "builder"
 *   T3 a bad enum (run kind, outcome, reason code) or version kept         → "builder"
 *   T4 the outcome map wrong (finished / failed / user stop / Keepr stop) → "outcome map"
 *   T5 the start row not written at claim                                  → "lifecycle"
 *   T6 the heartbeat not throttled, or sent after the terminal row         → "heartbeat"
 *   T7 the terminal row written before the save (no wait)                  → "after the save"
 *   T8 a late save rewriting outcome / reason (not a metrics follow-up)    → "follow-up"
 *   T9 an expired (never opened) Sync without a row / an unclaimed stop with one → "expiry"
 *   T10 the heartbeat not guarded on outcome = 'running'                   → "guarded heartbeat"
 *   T11 the follow-up write carrying outcome / reason_code                 → "metrics only"
 *   T12 a name / number / conversation id reaching any row                 → "privacy"
 */

import * as http from "http";

jest.mock("electron", () => ({ app: { getVersion: () => "2.38.1", isPackaged: true } }));
jest.mock("electron-log", () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn() } }));
jest.mock("../supabaseService", () => ({ __esModule: true, default: { getClient: jest.fn() } }));

import supabaseService from "../supabaseService";
import {
  RCS_SYNC_OUTCOME_SOURCE,
  RcsSyncOutcomeTracker,
  buildRcsSourceMetrics,
  cleanVersion,
  rcsOutcomeFor,
  type RcsOutcomeWriter,
} from "../rcsSyncOutcome";
import {
  buildSyncOutcomeRow,
  recordSyncRunMetrics,
  recordSyncRunProgressWhileRunning,
} from "../syncOutcomeSupabase";
import type { SyncOutcomeRow } from "../syncTimeline";
import { RCS_EXTENSION_ORIGIN, RcsExtensionBridge } from "../rcsExtensionBridge";
import { RcsJobRegistry, type RcsJobSnapshot } from "../rcsImportJob";

type Written = { verb: keyof RcsOutcomeWriter; row: SyncOutcomeRow };

function fakeWriter(): { writer: RcsOutcomeWriter; written: Written[] } {
  const written: Written[] = [];
  const w = (verb: keyof RcsOutcomeWriter) => (row: SyncOutcomeRow): void => void written.push({ verb, row: JSON.parse(JSON.stringify(row)) as SyncOutcomeRow });
  return { writer: { start: w("start"), heartbeat: w("heartbeat"), terminal: w("terminal"), metrics: w("metrics") }, written };
}

const EXT_METRICS = {
  finding: { ms: 4200, chatsFound: 180, chatsInRange: 40, chatsSkippedHidden: 3, chatsSkippedDisabled: 2 },
  reading: {
    ms: 61_000, chatsRead: 35, chatsSkipped: 3, chatsFailed: 2, chatsAlreadySaved: 0, messagesRead: 900, photosRead: 12, bytesRead: 3_500_000,
    perChatP50Ms: 1200, perChatP90Ms: 4800, perChatSlowestMs: 9000, chatsOpened: 40,
  },
  hidden: { ms: 5000, spells: 1 },
  chromeVersion: "141.0.7390.55",
};

function snap(over: Partial<RcsJobSnapshot> = {}): RcsJobSnapshot {
  return {
    jobId: "job-1",
    state: "running",
    stage: "",
    progress: { listed: 0, candidates: 0, checked: 0, matched: 0, imported: 0, messages: 0, images: 0, reactions: 0, skipped: 0, notChecked: 0, notText: 0, noMessagesYet: 0, removedNotRelinked: 0 } as RcsJobSnapshot["progress"],
    createdAt: "2026-10-04T10:00:00.000Z",
    kind: "cache",
    ...over,
  };
}

describe("buildRcsSourceMetrics (the only writer of source_metrics)", () => {
  it("named keys only: unknown keys, strings and arrays are dropped (T1)", () => {
    const m = buildRcsSourceMetrics({
      runKind: "sync",
      extension: {
        ...EXT_METRICS,
        finding: { ...EXT_METRICS.finding, chatNames: ["Test Person A"], extra: 5 },
        reading: { ...EXT_METRICS.reading, perChatMs: [1, 2, 3], conversationId: "abc" },
        names: ["Test Person A"],
      },
      saving: { ms: 900, messagesSaved: 880, messagesNew: 300, photosSaved: 12, bytesSaved: 3_400_000, number: "+15555550111" },
      end: { outcome: "complete", totalMs: 70_000, who: "Test Person A" },
    });
    expect(m).toEqual({
      v: 1,
      run_kind: "sync",
      finding: { ms: 4200, chats_found: 180, chats_in_range: 40, chats_skipped_hidden: 3, chats_skipped_disabled: 2 },
      reading: {
        ms: 61_000, chats_read: 35, chats_skipped: 3, chats_failed: 2, chats_already_saved: 0, messages_read: 900, photos_read: 12,
        bytes_read: 3_500_000, per_chat_p50_ms: 1200, per_chat_p90_ms: 4800, per_chat_slowest_ms: 9000, chats_opened: 40,
      },
      saving: { ms: 900, messages_saved: 880, messages_new: 300, photos_saved: 12, bytes_saved: 3_400_000 },
      end: { outcome: "complete", total_ms: 70_000, hidden_ms: 5000, hidden_spells: 1 },
    });
    expect(JSON.stringify(m)).not.toMatch(/Test Person|\+1555|abc|chatNames|perChatMs/);
  });

  // Live A/B (visible vs hidden tab): the run step totals pass as named
  // numeric keys. Mutation: a key not mapped → red.
  it("the run step totals: named ms keys", () => {
    const m = buildRcsSourceMetrics({
      runKind: "sync",
      extension: {
        reading: {
          detailsMs: 2100, historyMs: 2000, settleMs: 500, commitMs: 60,
          photoReadMs: 600, photoUploadMs: 120, photoReadMaxMs: 300, photoUploadMaxMs: 40,
        },
      },
    });
    expect(m.reading).toEqual({
      details_ms: 2100, history_ms: 2000, settle_ms: 500, commit_ms: 60,
      photo_read_ms: 600, photo_upload_ms: 120, photo_read_max_ms: 300, photo_upload_max_ms: 40,
    });
  });

  it("non-finite / negative / non-number values dropped; huge values clamped; fractions rounded (T2)", () => {
    const m = buildRcsSourceMetrics({
      extension: { finding: { ms: Infinity, chatsFound: -1, chatsInRange: NaN, chatsSkippedHidden: "3", chatsSkippedDisabled: 2.6 }, reading: { messagesRead: 1e12, bytesRead: 1e20 } },
    });
    expect(m.finding).toEqual({ chats_skipped_disabled: 3 });
    expect(m.reading).toEqual({ messages_read: 10_000_000, bytes_read: 1e13 });
  });

  it("enums from fixed sets; versions must look like versions (T3)", () => {
    const m = buildRcsSourceMetrics({ runKind: "weird", end: { outcome: "exploded", reasonCode: "Test Person A said no" } });
    expect(m).toEqual({ v: 1 });
    expect(buildRcsSourceMetrics({ runKind: "retry", end: { outcome: "error", reasonCode: "phone_unreachable" } })).toEqual({
      v: 1, run_kind: "retry", end: { outcome: "error", reason_code: "phone_unreachable" },
    });
    expect(cleanVersion("0.3.53")).toBe("0.3.53");
    expect(cleanVersion("141.0.7390.55")).toBe("141.0.7390.55");
    for (const bad of ["141", "1.2.3.4.5", "v1.2", "1.2-beta", "Chrome/141.0", 141, null]) expect(cleanVersion(bad)).toBeUndefined();
  });
});

describe("outcome map (T4)", () => {
  it("finished → complete; failed → error + its code; Stop sync → cancelled user_stop; Keepr's cancel → cancelled", () => {
    expect(rcsOutcomeFor({ state: "finished" })).toEqual({ outcome: "complete" });
    expect(rcsOutcomeFor({ state: "failed", error: { code: "phone_unreachable", message: "x" } })).toEqual({ outcome: "error", reasonCode: "phone_unreachable" });
    expect(rcsOutcomeFor({ state: "failed", error: { code: "Not A Code!", message: "x" } })).toEqual({ outcome: "error", reasonCode: "unknown" });
    expect(rcsOutcomeFor({ state: "cancelled", endedBy: "user_page" })).toEqual({ outcome: "cancelled", reasonCode: "user_stop", endedBy: "user_page" });
    expect(rcsOutcomeFor({ state: "cancelled" })).toEqual({ outcome: "cancelled", reasonCode: "keepr_cancel", endedBy: "keepr" });
  });
});

describe("RcsSyncOutcomeTracker", () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());
  const make = () => {
    const { writer, written } = fakeWriter();
    const t = new RcsSyncOutcomeTracker(writer, { now: () => now, heartbeatMs: 60_000, saveWaitMs: 30_000, newId: () => "run-1" });
    t.hello("0.3.53");
    return { t, written };
  };

  it("lifecycle: the start row at claim, typed columns, source google-messages (T5)", () => {
    const { t, written } = make();
    t.created("job-1", "older");
    expect(written).toHaveLength(0);
    t.claimed(snap());
    expect(written).toHaveLength(1);
    const { verb, row } = written[0];
    expect(verb).toBe("start");
    expect(row.source).toBe(RCS_SYNC_OUTCOME_SOURCE);
    expect(row.outcome).toBe("running");
    expect(row.runId).toBe("run-1");
    expect(row.fields).toMatchObject({ runKind: "older", extensionVersion: "0.3.53" });
  });

  it("heartbeat: throttled, and never after the terminal row (T6)", () => {
    const { t, written } = make();
    t.created("job-1", "sync");
    t.claimed(snap());
    now += 10_000;
    t.progress(snap({ progress: { ...snap().progress, listed: 50 } }));
    expect(written.filter((w) => w.verb === "heartbeat")).toHaveLength(0);
    now += 60_000;
    t.progress(snap({ progress: { ...snap().progress, listed: 120, candidates: 30 } }));
    const beats = written.filter((w) => w.verb === "heartbeat");
    expect(beats).toHaveLength(1);
    expect(beats[0].row.fields).toMatchObject({ lastPhase: "reading" });
    t.extensionMetrics("job-1", EXT_METRICS);
    // Ended (a finished cache Sync still waiting for its save): no more beats.
    t.ended(snap({ state: "finished" }));
    now += 120_000;
    t.progress(snap());
    expect(written.filter((w) => w.verb === "heartbeat")).toHaveLength(1);
  });

  it("a finished cache Sync: the terminal row AFTER the save, with what Keepr saved (T7)", () => {
    const { t, written } = make();
    t.created("job-1", "sync");
    t.claimed(snap());
    now += 70_000;
    t.extensionMetrics("job-1", EXT_METRICS);
    t.finishing("job-1");
    t.photoStored("job-1", 1_000_000);
    t.photoStored("job-1", 500_000);
    t.ended(snap({ state: "finished" }));
    expect(written.filter((w) => w.verb === "terminal")).toHaveLength(0); // waiting for the save
    now += 2_000;
    t.saved(snap({ state: "finished" }), { chats: 30, messages: 880, newMessages: 300, photos: 12 });
    const term = written.filter((w) => w.verb === "terminal");
    expect(term).toHaveLength(1);
    const row = term[0].row;
    expect(row.outcome).toBe("complete");
    expect(row.elapsedMs).toBe(70_000);
    expect(row.phases).toEqual([
      { phase: "finding", elapsedMs: 4200 },
      { phase: "reading", elapsedMs: 61_000 },
      { phase: "saving", elapsedMs: 2000 },
    ]);
    expect(row.sourceMetrics).toMatchObject({
      run_kind: "sync",
      saving: { ms: 2000, messages_saved: 880, messages_new: 300, photos_saved: 12, bytes_saved: 1_500_000 },
      end: { outcome: "complete", total_ms: 70_000 },
    });
    expect(row.fields).toMatchObject({ chromeVersion: "141.0.7390.55", extensionVersion: "0.3.53" });
  });

  it("a save slower than the wait: terminal at the wait, then a metrics-only follow-up (T8)", async () => {
    const { t, written } = make();
    t.created("job-1", "sync");
    t.claimed(snap());
    t.extensionMetrics("job-1", EXT_METRICS);
    t.finishing("job-1");
    t.ended(snap({ state: "finished" }));
    jest.advanceTimersByTime(30_000);
    expect(written.filter((w) => w.verb === "terminal")).toHaveLength(1);
    expect(written.filter((w) => w.verb === "terminal")[0].row.sourceMetrics).not.toHaveProperty("saving");
    now += 45_000;
    t.saved(snap({ state: "finished" }), { chats: 30, messages: 880, newMessages: 300, photos: 12 });
    await Promise.resolve();
    await Promise.resolve();
    expect(written.map((w) => w.verb)).toEqual(["start", "terminal", "metrics"]);
    const follow = written[2].row;
    expect(follow.runId).toBe("run-1");
    expect(follow.sourceMetrics).toMatchObject({ saving: { messages_saved: 880, ms: 45_000 } });
  });

  // SR (telemetry approval): the follow-up goes strictly AFTER the terminal
  // upsert resolves — never concurrently — so the terminal row (no saving
  // block) can never land last and overwrite it. Mutation: the follow-up
  // sent at once (not chained) → red.
  it("the follow-up waits for the terminal write; the saving block survives (last write wins)", async () => {
    const store: { row?: Record<string, unknown> } = {};
    const order: string[] = [];
    let landTerminal: () => void = () => undefined;
    const writer: RcsOutcomeWriter = {
      start: () => undefined,
      heartbeat: () => undefined,
      terminal: (row) => {
        order.push("terminal sent");
        return new Promise<void>((resolve) => {
          landTerminal = () => {
            store.row = { ...(row.sourceMetrics ?? {}) };
            order.push("terminal landed");
            resolve();
          };
        });
      },
      metrics: (row) => {
        order.push("metrics sent");
        store.row = { ...(row.sourceMetrics ?? {}) };
      },
    };
    const t = new RcsSyncOutcomeTracker(writer, { now: () => now, saveWaitMs: 30_000, newId: () => "run-1" });
    t.created("job-1", "sync");
    t.claimed(snap());
    t.finishing("job-1");
    t.ended(snap({ state: "finished" }));
    jest.advanceTimersByTime(30_000); // terminal sent, still in flight
    t.saved(snap({ state: "finished" }), { chats: 3, messages: 40, newMessages: 10, photos: 2 });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual(["terminal sent"]); // not concurrently
    landTerminal();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(order).toEqual(["terminal sent", "terminal landed", "metrics sent"]);
    expect(store.row).toMatchObject({ saving: { messages_saved: 40, messages_new: 10, photos_saved: 2 } });
  });

  it("failed: error + the failure code; Stop sync: cancelled user_stop", () => {
    const a = make();
    a.t.created("job-1", "sync");
    a.t.claimed(snap());
    a.t.ended(snap({ state: "failed", error: { code: "list_not_reachable", message: "x" } }));
    expect(a.written[1]).toMatchObject({ verb: "terminal", row: { outcome: "error", fields: { reasonCode: "list_not_reachable" } } });
    expect(a.written[1].row.sourceMetrics).toMatchObject({ end: { outcome: "error", reason_code: "list_not_reachable" } });
    const b = make();
    b.t.created("job-1", "sync");
    b.t.claimed(snap());
    b.t.ended(snap({ state: "cancelled", endedBy: "user_page" }));
    expect(b.written[1]).toMatchObject({ verb: "terminal", row: { outcome: "cancelled", fields: { reasonCode: "user_stop", endedBy: "user_page" } } });
  });

  it("expiry: a Sync never opened gets a terminal row; an unclaimed cancel gets none (T9)", () => {
    const a = make();
    a.t.created("job-1", "sync");
    a.t.ended(snap({ state: "failed", error: { code: "not_opened", message: "x" } }));
    expect(a.written).toHaveLength(1);
    expect(a.written[0]).toMatchObject({ verb: "terminal", row: { outcome: "error", fields: { reasonCode: "not_opened" } } });
    const b = make();
    b.t.created("job-1", "sync");
    b.t.ended(snap({ state: "cancelled" }));
    expect(b.written).toHaveLength(0);
  });
});

describe("the writer's new verbs", () => {
  let calls: Array<{ op: string; args: unknown[] }>;
  beforeEach(() => {
    calls = [];
    const chain = (): Record<string, unknown> => {
      const c: Record<string, unknown> = {
        eq: (...args: unknown[]) => {
          calls.push({ op: "eq", args });
          return c;
        },
        then: (res: (v: unknown) => void) => res({ error: null }),
      };
      return c;
    };
    (supabaseService.getClient as jest.Mock).mockReturnValue({
      auth: { getSession: async () => ({ data: { session: { user: { id: "user-1" } } } }) },
      from: () => ({
        update: (payload: unknown) => {
          calls.push({ op: "update", args: [payload] });
          return chain();
        },
        upsert: (payload: unknown) => {
          calls.push({ op: "upsert", args: [payload] });
          return Promise.resolve({ error: null });
        },
      }),
    });
  });
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const ROW: SyncOutcomeRow = {
    source: RCS_SYNC_OUTCOME_SOURCE, outcome: "complete", elapsedMs: 1000, phases: [], runId: "run-1", startedAt: 1,
    fields: { reasonCode: "x", runKind: "sync" }, sourceMetrics: { v: 1 },
  };

  it("the heartbeat only touches a row still running — a late one never rewrites a finished row (T10)", async () => {
    recordSyncRunProgressWhileRunning({ ...ROW, outcome: "running" });
    await flush();
    expect(calls.filter((c) => c.op === "eq").map((c) => c.args)).toEqual([["id", "run-1"], ["outcome", "running"]]);
    expect(calls[0].args[0]).not.toHaveProperty("outcome");
  });

  it("a follow-up updates source_metrics only — never outcome or reason_code (T11)", async () => {
    recordSyncRunMetrics(ROW);
    await flush();
    const payload = calls.find((c) => c.op === "update")!.args[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["source_metrics", "updated_at"]);
    expect(calls.filter((c) => c.op === "eq").map((c) => c.args)).toEqual([["id", "run-1"]]);
  });

  it("buildSyncOutcomeRow maps source_metrics and the typed columns; an iPhone row has none of them", () => {
    const row = buildSyncOutcomeRow({ ...ROW, fields: { runKind: "sync", extensionVersion: "0.3.53", chromeVersion: "141.0.7390.55" } }, "user-1");
    expect(row).toMatchObject({ source_metrics: { v: 1 }, run_kind: "sync", extension_version: "0.3.53", chrome_version: "141.0.7390.55" });
    const iphone = buildSyncOutcomeRow({ source: "iphone-sync", outcome: "complete", elapsedMs: 1, phases: [], runId: "r", startedAt: 1, fields: {} }, "user-1");
    for (const k of ["source_metrics", "run_kind", "extension_version", "chrome_version"]) expect(iphone).not.toHaveProperty(k);
  });
});

// The bridge's hooks, over real HTTP: claim → start, /progress → heartbeat,
// /finish with the page's numbers → terminal (after the save for a cache
// Sync). Junk the page might add (names, numbers, ids) never reaches a row.
describe("through the bridge (privacy, T12)", () => {
  function request(port: number, path: string, body?: unknown): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", Origin: RCS_EXTENSION_ORIGIN } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  it("a cache Sync's rows: start, heartbeat, terminal after the save — counts only", async () => {
    const { writer, written } = fakeWriter();
    const tracker = new RcsSyncOutcomeTracker(writer, { heartbeatMs: 0, newId: () => "run-b" });
    const bridge = new RcsExtensionBridge({
      jobs: new RcsJobRegistry(),
      telemetry: tracker,
      finishSaveWaitMs: 2000,
    });
    expect(await bridge.start(0)).toBe("listening");
    try {
      const port = bridge.getStatus().port;
      await request(port, "/hello", { version: "0.3.53" });
      const job = bridge.createCacheJob("user-1", { since: "2026-09-01T00:00:00.000Z" })!;
      tracker.created(job.jobId, "sync");
      expect(await request(port, `/job/${job.jobId}/claim`)).toBe(200);
      expect(written.map((w) => w.verb)).toEqual(["start"]);
      await request(port, `/job/${job.jobId}/progress`, { stage: "Chat 1 of 3", listed: 9, candidates: 3, checked: 1 });
      expect(written.map((w) => w.verb)).toEqual(["start", "heartbeat"]);
      const finishing = request(port, `/job/${job.jobId}/finish`, {
        chats: 2, messages: 10, images: 0,
        metrics: { ...EXT_METRICS, chatNames: ["Test Person A"], numbers: ["+15555550111"], reading: { ...EXT_METRICS.reading, conversationId: "conv-xyz" } },
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(written.map((w) => w.verb)).toEqual(["start", "heartbeat"]); // waiting for the save
      bridge.recordCacheSaved(job.jobId, { chats: 2, messages: 10, newMessages: 4, photos: 0 });
      expect(await finishing).toBe(200);
      expect(written.map((w) => w.verb)).toEqual(["start", "heartbeat", "terminal"]);
      const term = written[2].row;
      expect(term).toMatchObject({ source: "google-messages", outcome: "complete", runId: "run-b", fields: { extensionVersion: "0.3.53", chromeVersion: "141.0.7390.55" } });
      expect(term.sourceMetrics).toMatchObject({ saving: { messages_saved: 10, messages_new: 4 } });
      const all = JSON.stringify(written);
      expect(all).not.toMatch(/Test Person|\+1555|5555550111|conv-xyz|user-1|chatNames|Chat 1 of 3/);
    } finally {
      await bridge.stop();
    }
  });
});

// The ONE branch migration (not applied anywhere). Mutations: a default, a
// NOT NULL, a CHECK on a text column, the size cap validated (no NOT VALID)
// or loosened, a policy / grant change, a second migration → red.
describe("migration hygiene", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = path.join(__dirname, "..", "..", "..", "supabase", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.includes("backlog_3671"));
  const raw = files.length === 1 ? fs.readFileSync(path.join(dir, files[0]), "utf8").replace(/\r\n?/g, "\n") : "";
  const sqlOnly = raw.split("\n").map((l) => l.replace(/--.*$/, "")).join(" ").replace(/\s+/g, " ");

  // Applied to production as version 20261004222332 (supabase_migrations
  // history): the file carries that version, so its place in the order is the
  // one it was applied in — develop's later migrations (3726, …) sort after it.
  // Mutation: the file back under its pre-apply name → red.
  it("exactly one 3671 migration, under the version it was applied as", () => {
    expect(files).toEqual(["20261004222332_backlog_3671_google_messages_sync_metrics.sql"]);
  });

  it("four nullable columns, no default; the size cap NOT VALID; nothing else", () => {
    for (const [col, type] of [["source_metrics", "jsonb"], ["run_kind", "text"], ["extension_version", "text"], ["chrome_version", "text"]]) {
      expect(sqlOnly).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col} ${type}[,;]`));
    }
    expect(sqlOnly).not.toMatch(/DEFAULT|NOT NULL|GRANT|REVOKE|POLICY|DROP COLUMN|DROP TABLE/i);
    expect(sqlOnly).toContain("CHECK (pg_column_size(source_metrics) < 32768) NOT VALID");
    expect((sqlOnly.match(/CHECK \(/g) ?? []).length).toBe(1);
    // The rollback is written down.
    expect(raw).toMatch(/-- ROLLBACK:[\s\S]*DROP COLUMN IF EXISTS source_metrics/);
  });

  it("the writer's column names are the migration's", () => {
    const row = buildSyncOutcomeRow(
      { source: RCS_SYNC_OUTCOME_SOURCE, outcome: "complete", elapsedMs: 1, phases: [], runId: "r", startedAt: 1, sourceMetrics: { v: 1 }, fields: { runKind: "sync", extensionVersion: "0.3.53", chromeVersion: "141.0.0.0" } },
      "u",
    );
    for (const k of ["source_metrics", "run_kind", "extension_version", "chrome_version"]) {
      expect(row).toHaveProperty(k);
      expect(sqlOnly).toContain(`ADD COLUMN IF NOT EXISTS ${k} `);
    }
  });
});
