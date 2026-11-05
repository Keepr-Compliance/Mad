/**
 * @jest-environment node
 *
 * BACKLOG-4130 — the email pre-cache run as a sync_outcomes row.
 *
 * Every assertion is on `buildSyncOutcomeRow(builder(...))` — the row the
 * database actually receives — never on the builder's output alone. A key the
 * builder puts in the wrong place (top-level instead of `fields`) is silently
 * dropped by `buildSyncOutcomeRow`, and only the DB row shows it.
 *
 * FIXTURE PROVENANCE: `timingRecord()` is transcribed from the timing literal
 * in `emailSyncService.precacheEmails`' `finally` (the `const timing = {...}`
 * object: mode, outcome, providers, checked, written, inserted on a force swap
 * only, elapsedMs, build, dbMs). Values are synthetic counts; no mail content.
 *
 * CONTROLS, AND THE MUTATION THAT MAKES EACH RED
 *   C1 exact key set      -> builder spreads its input into sourceMetrics
 *                            (`{ ...timing, ... }`): RED
 *   mapping               -> outcome passed through unmapped: RED
 *   run_kind reaches row  -> runKind top-level instead of in `fields`: RED
 */

jest.mock("electron", () => ({ app: { getVersion: () => "2.46.0", isPackaged: true } }));
jest.mock("electron-log", () => ({ __esModule: true, default: { warn: jest.fn(), info: jest.fn() } }));
jest.mock("../supabaseService", () => ({ __esModule: true, default: { getClient: jest.fn() } }));

import {
  buildEmailPrecacheOutcomeRow,
  buildEmailPrecacheSourceMetrics,
  EMAIL_PRECACHE_OUTCOME_SOURCE,
  mapPrecacheOutcome,
} from "../emailPrecacheOutcome";
import { buildSyncOutcomeRow } from "../syncOutcomeSupabase";
import type { EmailPrecacheTimingRecord } from "../emailPrecacheTiming";

/** sync_outcomes_outcome_check (migration 20260918180000, :89-91). */
const OUTCOME_CHECK_SET = ["complete", "cancelled", "error", "running"];

const RUN_STARTED_AT = Date.parse("2026-11-05T10:00:00Z");
const FIXTURE_UID = "fixture-uid";

/** Transcribed from the `const timing = {...}` literal in precacheEmails' finally. */
function timingRecord(overrides: Partial<EmailPrecacheTimingRecord> = {}): EmailPrecacheTimingRecord {
  return {
    mode: "cache",
    outcome: "success",
    providers: ["outlook"],
    checked: 1234,
    written: 1200,
    elapsedMs: 98765,
    build: "2.46.0",
    dbMs: 4321,
    ...overrides,
  };
}

function dbRow(timing: EmailPrecacheTimingRecord, ctx: { windowMonths?: number; backfill: boolean }) {
  return buildSyncOutcomeRow(
    buildEmailPrecacheOutcomeRow(timing, { runStartedAt: RUN_STARTED_AT, ...ctx }),
    FIXTURE_UID,
  );
}

/**
 * Content that must never leave the machine, injected onto the input as if a
 * future caller spread a wider object (the log context adds `userId`).
 */
const CONTENT = {
  userId: "local-user-7f3a",
  subject: "Offer on 12 Example Lane",
  from: "agent@example.com",
  messageId: "<msg-1@example.com>",
  folder: "Inbox/Deals",
  displayName: "Pat Example",
};

describe("BACKLOG-4130 C1 — source_metrics carries named keys only", () => {
  it("exact key set on a full run, with content keys injected on the input", () => {
    const timing = { ...timingRecord(), ...CONTENT } as unknown as EmailPrecacheTimingRecord;
    const row = dbRow(timing, { windowMonths: 12, backfill: false });

    expect(Object.keys(row.source_metrics as object).sort()).toEqual(
      ["backfill", "build", "checked", "dbMs", "providers", "windowMonths", "written"].sort(),
    );
    expect(row.source_metrics).toEqual({
      providers: ["outlook"],
      checked: 1234,
      written: 1200,
      dbMs: 4321,
      build: "2.46.0",
      windowMonths: 12,
      backfill: false,
    });
    const json = JSON.stringify(row);
    for (const value of Object.values(CONTENT)) expect(json).not.toContain(value);
    expect(json).not.toContain("example.com");
  });

  it("a force swap adds `inserted` and nothing else", () => {
    const row = dbRow(timingRecord({ mode: "force", inserted: 1190, providers: ["gmail", "outlook"] }), {
      windowMonths: 6,
      backfill: false,
    });
    expect(Object.keys(row.source_metrics as object).sort()).toEqual(
      ["backfill", "build", "checked", "dbMs", "inserted", "providers", "windowMonths", "written"].sort(),
    );
  });

  it("a run that ended before the window was read omits windowMonths", () => {
    const row = dbRow(timingRecord({ providers: [] }), { backfill: false });
    expect(Object.keys(row.source_metrics as object).sort()).toEqual(
      ["backfill", "build", "checked", "dbMs", "providers", "written"].sort(),
    );
    expect((row.source_metrics as { providers: string[] }).providers).toEqual([]);
  });

  it("drops an unknown provider and an unrecognised build string", () => {
    const metrics = buildEmailPrecacheSourceMetrics(
      timingRecord({ providers: ["outlook", "me@example.com", "imap"], build: "build for Pat Example" }),
      { windowMonths: 3, backfill: true },
    );
    expect(metrics.providers).toEqual(["outlook"]);
    expect(metrics.build).toBe("unknown");
    expect(metrics.backfill).toBe(true);
  });

  it("the row's fields carry runKind and incremental only", () => {
    const timing = { ...timingRecord(), ...CONTENT } as unknown as EmailPrecacheTimingRecord;
    const row = buildEmailPrecacheOutcomeRow(timing, { runStartedAt: RUN_STARTED_AT, backfill: false });
    expect(Object.keys(row.fields).sort()).toEqual(["incremental", "runKind"]);
  });
});

describe("BACKLOG-4130 — outcome mapping", () => {
  it.each([
    ["success", "complete"],
    ["error", "error"],
    ["cancelled", "cancelled"],
  ] as const)("%s -> %s, inside the outcome CHECK set", (timingOutcome, expected) => {
    expect(mapPrecacheOutcome(timingOutcome)).toBe(expected);
    const row = dbRow(timingRecord({ outcome: timingOutcome }), { windowMonths: 12, backfill: false });
    expect(row.outcome).toBe(expected);
    expect(OUTCOME_CHECK_SET).toContain(row.outcome);
  });
});

describe("BACKLOG-4130 — row columns", () => {
  it.each([
    ["cache", false],
    ["re-cache", true],
    ["force", false],
  ] as const)("mode %s -> run_kind %s, incremental %s", (mode, incremental) => {
    const row = dbRow(timingRecord({ mode }), { windowMonths: 12, backfill: false });
    expect(row.run_kind).toBe(mode);
    expect(row.incremental).toBe(incremental);
  });

  it("source, elapsed, start time and a run id reach the row", () => {
    const row = dbRow(timingRecord(), { windowMonths: 12, backfill: false });
    expect(row.source).toBe(EMAIL_PRECACHE_OUTCOME_SOURCE);
    expect(row.source).toBe("email-precache");
    expect(row.elapsed_ms).toBe(98765);
    expect(row.started_at).toBe(new Date(RUN_STARTED_AT).toISOString());
    expect(row.user_id).toBe(FIXTURE_UID);
    expect(typeof row.id).toBe("string");
    expect(row.phases).toEqual([]);
  });

  it("each run gets its own id", () => {
    const a = buildEmailPrecacheOutcomeRow(timingRecord(), { runStartedAt: RUN_STARTED_AT, backfill: false });
    const b = buildEmailPrecacheOutcomeRow(timingRecord(), { runStartedAt: RUN_STARTED_AT, backfill: false });
    expect(a.runId).not.toBe(b.runId);
  });
});
