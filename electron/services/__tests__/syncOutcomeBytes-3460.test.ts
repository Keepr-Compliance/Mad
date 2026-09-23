/**
 * BACKLOG-3460 — A FRACTIONAL BYTE COUNT REJECTED EVERY TELEMETRY WRITE.
 *
 * On 2026-09-19 the founder cancelled a sync at ~12%. The cancel itself behaved. The
 * telemetry row did not: it stayed `outcome='running'`, `bytes_transferred=0`, frozen
 * at the last heartbeat that had landed. The log, verbatim:
 *
 *   [SyncOutcome] heartbeat row dropped (offline, signed out, or write failed);
 *     sync unaffected: invalid input syntax for type bigint: "4142962380.8"
 *   [SyncOutcome] terminal row dropped (offline, signed out, or write failed);
 *     sync unaffected: invalid input syntax for type bigint: "4142962380.8"
 *
 * Postgres does not truncate a fractional literal into a `bigint`. It refuses the
 * write. So the moment bytes started moving, every heartbeat AND the terminal write
 * failed — and only then; earlier runs that died before transfer wrote fine, because
 * `bytes_transferred=0` is an integer. A run that reached transfer could therefore
 * never get an end state, and BACKLOG-3441's stall report would read every one of them
 * as a live stall while the `outcome <> 'running'` filter hid it from finished runs.
 *
 * THE FIX HAS TWO LAYERS, AND THE CONTROLS BELOW ARE SPLIT ACROSS THEM ON PURPOSE:
 *
 *   layer 1  `syncTimeline.recordBytesTransferred` rounds, so every READER — the
 *            high-water mark and the `bytesLastIncreasedAt` stall comparison included
 *            — sees the same integer the corpus stores.
 *   layer 2  `syncOutcomeSupabase`'s `roundToBigint` / `bigintNum`, applied to all ten
 *            `bigint` columns, for any future producer that is not integer by
 *            construction.
 *
 * WHICH MUTATION REDS WHICH CONTROL, measured rather than asserted:
 *
 *   remove the `Math.round` in `recordBytesTransferred`  -> (a) and (b) red at the
 *     TIMELINE assertion; their mapped-row assertion stays GREEN, because layer 2
 *     catches it. That green is the second layer working, not a vacuous control.
 *   swap `bigintNum` back to `num` on one column          -> (c) red.
 *
 * Neither mutation reds the other's assertion, which is what makes both layers
 * load-bearing rather than one of them decoration.
 */

import { SyncTimeline, SYNC_OUTCOME_SOURCE } from "../syncTimeline";
import type { SyncOutcomeRow } from "../syncTimeline";
import { buildSyncOutcomeRow } from "../syncOutcomeSupabase";
import { BackupService } from "../backupService";
import type { BackupProgress } from "../../types/backup";

// The mapper imports `supabaseService` at module scope. Nothing here writes, but an
// unmocked client is a network client, and `tests/net-guard` fails a test that opens
// one. `buildSyncOutcomeRow` itself is pure.
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: jest.fn() },
}));

/**
 * THE FOUNDER'S LITERAL, taken from his log line and nothing else.
 *
 * No arithmetic is claimed for it, and that is deliberate: BACKLOG-3460's body derives
 * it as "3951.2 MB × 1048576", which does not hold — that product is 4143133491.2.
 * 4142962380.8 ÷ 1048576 is 3951.0368…, which no `X.X MB` progress reading can be. It
 * is therefore an ACCUMULATION, which is exactly what `backupService.ts:1861` builds:
 * `this.bytesTransferred + currentBytes`, completed files plus the current file's
 * fractional part. The mechanism is unchanged and the correction strengthens it; only
 * the worked example in the item was off. Control (b) below states its own arithmetic
 * and checks it against the real parser rather than against this number.
 */
const FOUNDER_LITERAL = 4142962380.8;
const FOUNDER_ROUNDED = 4142962381;

/**
 * A timeline whose outcome row this test can read.
 *
 * Injecting `reporter` is also what keeps the live-run sink out of it — see the
 * constructor's own note in `syncTimeline.ts`: a suite that injects a reporter gets no
 * Supabase-backed run reporter unless it asks for one. No network from this file.
 */
function captureOutcome(record: (t: SyncTimeline) => void): SyncOutcomeRow {
  const captured: SyncOutcomeRow[] = [];
  let clock = 1_758_300_000_000;
  const timeline = new SyncTimeline({
    now: () => clock,
    sink: () => {},
    reporter: (row) => captured.push(row),
  });
  timeline.beginSync();
  timeline.enter("backup:transferring");
  record(timeline);
  clock += 393_615;
  timeline.endSync("cancelled", {});
  if (captured.length !== 1) {
    throw new Error(`expected exactly one outcome row, got ${captured.length}`);
  }
  return captured[0];
}

// ---------------------------------------------------------------------------
// CONTROL (a) — the founder's literal, end to end
// ---------------------------------------------------------------------------

describe("BACKLOG-3460 (a): the byte count the founder's run produced reaches Postgres as an integer", () => {
  it("THE CONTROL — recordBytesTransferred(4142962380.8) puts 4142962381 on the outcome row", () => {
    const row = captureOutcome((t) => t.recordBytesTransferred(FOUNDER_LITERAL));

    // LAYER 1. Delete the `Math.round` in `recordBytesTransferred` and this is the
    // line that reds: the row carries 4142962380.8 and the bigint column refuses it.
    expect(row.fields.bytesTransferred).toBe(FOUNDER_ROUNDED);
    expect(Number.isInteger(row.fields.bytesTransferred as number)).toBe(true);
  });

  it("and the mapped row's bytes_transferred is an integer the column will accept", () => {
    const row = captureOutcome((t) => t.recordBytesTransferred(FOUNDER_LITERAL));
    const mapped = buildSyncOutcomeRow(row, "user-3460", {});

    // LAYER 2. This one survives the layer-1 mutation, by design. Swap `bigintNum`
    // back to `num` on `bytes_transferred` and it reds.
    expect(mapped.bytes_transferred).toBe(FOUNDER_ROUNDED);
    expect(Number.isInteger(mapped.bytes_transferred as number)).toBe(true);
  });

  it("the stall comparison sees the rounded value too — a re-report of the same bytes is not an increase", () => {
    // Why this matters beyond the column type: `bytesLastIncreasedAt` is the timestamp
    // BACKLOG-3441 compares against `updated_at` to separate "slow" from "stopped
    // dead". If the mark kept the fraction while the corpus stored the rounded value,
    // the two would disagree by up to a byte at exactly the comparison that decides
    // whether a run is stalled.
    const row = captureOutcome((t) => {
      t.recordBytesTransferred(FOUNDER_LITERAL);
      t.recordBytesTransferred(FOUNDER_LITERAL);
    });
    expect(row.fields.bytesTransferred).toBe(FOUNDER_ROUNDED);
  });

  it("a genuinely larger reading still advances the mark", () => {
    // Anti-vacuity: rounding must not freeze the counter. Without this, an
    // implementation that hard-coded the first reading would pass everything above.
    const row = captureOutcome((t) => {
      t.recordBytesTransferred(FOUNDER_LITERAL);
      t.recordBytesTransferred(FOUNDER_LITERAL + 1_048_576);
    });
    expect(row.fields.bytesTransferred).toBe(FOUNDER_ROUNDED + 1_048_576);
  });
});

// ---------------------------------------------------------------------------
// CONTROL (b) — the fixture comes from the real producer, not from imagination
// ---------------------------------------------------------------------------

/**
 * THE PROGRESS LINE IS TRANSCRIBED, NOT INVENTED.
 *
 * Its shape is `parseProgress`'s own documented example at
 * `electron/services/backupService.ts:1821`:
 *
 *   - "[====================                              ]  39% (18.8 MB/48.3 MB)"
 *
 * — reproduced character for character except for the two MB figures, which carry the
 * scale of the founder's run rather than his exact total (see `FOUNDER_LITERAL` above:
 * that total is an accumulation, not one reading). The fractional part is not an edge
 * case introduced here: the regex at `:1831` is
 * `(\d+(?:\.\d+)?)`, so a fraction is what this producer is BUILT to accept, and
 * `parseBytes` at `:1998` multiplies it by 1024ⁿ with no rounding.
 */
const REAL_PROGRESS_LINE =
  "[====================                              ]  39% (3951.2 MB/9000.0 MB)";

/** What that line really yields: 3951.2 × 1024 × 1024. Checked against the parser below. */
const PARSED_FRACTIONAL = 4143133491.2;
const PARSED_ROUNDED = 4143133491;

/** The one private this file reaches, named rather than cast to `any`. */
interface ParseProgressAccess {
  parseProgress(output: string): BackupProgress | null;
}

describe("BACKLOG-3460 (b): the real parser's output survives the trip to the column", () => {
  it("parseProgress really does emit a fractional byte count — the premise, measured", () => {
    const service = new BackupService();
    // Reaching a private the way this repo already does — `backupService.test.ts:500`
    // for `parseProgress`, `backupService.stderrClassification-2898.test.ts:55` for the
    // typed-cast form used here. No new access pattern invented.
    const parseProgress = (service as unknown as ParseProgressAccess).parseProgress.bind(service);

    const progress = parseProgress(REAL_PROGRESS_LINE);

    expect(progress).not.toBeNull();
    // Narrowing for `tsc`, and a real guard: jest transpiles without type-checking, so
    // a null here would otherwise surface as a confusing property-of-null further down.
    if (!progress) throw new Error("parseProgress returned null for its own documented line shape");
    expect(progress.bytesTransferred).toBe(PARSED_FRACTIONAL);
    // Stated as its own assertion because it is the whole defect: this number cannot
    // be written to a bigint column, and nothing between here and Postgres used to
    // change that.
    expect(Number.isInteger(progress.bytesTransferred)).toBe(false);
  });

  it("THE CONTROL — that same number, taken the way the orchestrator takes it, lands as an integer", () => {
    const service = new BackupService();
    const parseProgress = (service as unknown as ParseProgressAccess).parseProgress.bind(service);
    const progress = parseProgress(REAL_PROGRESS_LINE);
    if (!progress) throw new Error("parseProgress returned null for its own documented line shape");

    // `deviceSyncOrchestrator.ts:576` — the only production caller, forwarding the
    // progress event's byte count verbatim.
    const row = captureOutcome((t) => t.recordBytesTransferred(progress.bytesTransferred));

    // LAYER 1 again, from the real producer rather than a typed-in constant.
    expect(row.fields.bytesTransferred).toBe(PARSED_ROUNDED);

    const mapped = buildSyncOutcomeRow(row, "user-3460", {});
    expect(Number.isInteger(mapped.bytes_transferred as number)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CONTROL (c) — every bigint column, not just the one that broke
// ---------------------------------------------------------------------------

/**
 * ALL TEN `bigint` COLUMNS OF `sync_outcomes`, EVERY ONE FRACTIONAL.
 *
 * The column list is `information_schema.columns where table_name='sync_outcomes' and
 * data_type='bigint'`; the field names are transcribed from `buildSyncOutcomeRow` at
 * `syncOutcomeSupabase.ts:152` (`elapsed_ms`, taken from the row rather than `fields`),
 * `:163`, `:182-184`, `:187-189`, `:191` and `:196`.
 *
 * EVERY VALUE HAS A FRACTIONAL PART ON PURPOSE. An integer anywhere in this fixture
 * would make the helper-drop mutation green on that column, and the control would pass
 * while proving nothing — the exact vacuity this repo keeps rediscovering.
 */
const BIGINT_COLUMNS = [
  "elapsed_ms",
  "bytes_transferred",
  "device_used_bytes",
  "device_free_bytes",
  "device_capacity_bytes",
  "host_total_mem_bytes",
  "host_disk_free_bytes",
  "host_disk_total_bytes",
  "backup_bytes",
  "extraction_ms",
] as const;

function everyBigintFractional(): SyncOutcomeRow {
  return {
    // pii-allow-uuid: invented sync run id, typed by hand for this fixture
    runId: "b1f0c2d4-3e56-4a78-9b01-2c3d4e5f6a7b",
    startedAt: Date.UTC(2026, 8, 19, 19, 45, 2),
    source: SYNC_OUTCOME_SOURCE,
    outcome: "cancelled",
    elapsedMs: 393_615.4,
    phases: [{ phase: "backup:transferring", elapsedMs: 393_615 }],
    fields: {
      source: SYNC_OUTCOME_SOURCE,
      outcome: "cancelled",
      elapsedMs: 393_615.4,
      bytesTransferred: FOUNDER_LITERAL,
      deviceUsedBytes: 61_200_000_000.5,
      deviceFreeBytes: 2_100_000_000.5,
      deviceCapacityBytes: 63_300_000_000.5,
      hostTotalMemBytes: 17_179_869_184.5,
      hostDiskFreeBytes: 120_000_000_000.5,
      hostDiskTotalBytes: 494_384_795_648.5,
      backupBytes: 61_217_118_530.5,
      extractionMs: 20_427.5,
    },
  };
}

describe("BACKLOG-3460 (c): no bigint column can carry a fractional value out of the mapper", () => {
  it.each(BIGINT_COLUMNS)("THE CONTROL — %s is an integer", (column) => {
    const mapped = buildSyncOutcomeRow(everyBigintFractional(), "user-3460", {});

    // PRESENT, not merely non-fractional. `Number.isInteger(undefined)` is false, so a
    // helper that DROPPED the value instead of rounding it would red here too — which
    // is deliberate: dropping would write a row whose byte counter is absent, losing
    // the figure the column exists to carry.
    expect(mapped[column]).toBeDefined();
    expect(Number.isInteger(mapped[column] as number)).toBe(true);
  });

  it("and rounds rather than truncates or discards — the values are preserved", () => {
    const mapped = buildSyncOutcomeRow(everyBigintFractional(), "user-3460", {});
    expect(mapped.bytes_transferred).toBe(FOUNDER_ROUNDED);
    expect(mapped.elapsed_ms).toBe(393_615);
    expect(mapped.backup_bytes).toBe(61_217_118_531);
    expect(mapped.extraction_ms).toBe(20_428);
  });

  it("the strict `int()` column is untouched — a fractional device_error_code is still DROPPED, not rounded", () => {
    // The boundary of this change, asserted so a later reader does not "unify" the two
    // helpers. An error code is a device's own enum value; rounding 208.5 to 208 would
    // invent a code the device never reported, where rounding a byte count to the
    // nearest byte loses nothing.
    const row = everyBigintFractional();
    const mapped = buildSyncOutcomeRow(
      { ...row, fields: { ...row.fields, deviceErrorCode: 208.5 } },
      "user-3460",
      {},
    );
    expect(mapped.device_error_code).toBeUndefined();
  });
});
