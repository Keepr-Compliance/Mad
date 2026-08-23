/**
 * @jest-environment node
 *
 * BACKLOG-2788 — the closing day ends at the AGENT'S LOCAL midnight, everywhere.
 *
 * Founder decision, 2026-08-22: "think about it from the agent's perspective,
 * they work in their local time, so we need to show the transaction from their
 * eyes." The walk-through that produced it: a transaction closed 2026-07-29,
 * agent in America/Chicago, a client text at 9pm local on the closing day. The
 * Texts tab showed it as in-period; the export and the broker submission both
 * dropped it, because their bound was UTC midnight of the next day — 7pm local.
 * Five hours of the closing day existed on one surface and not the other two.
 *
 * This suite is the cross-surface control. It drives the SAME instants through
 * all three surfaces at once:
 *
 *   export      resolveExportPlan()            (electron/services/exportPlan.ts)
 *   submission  getTransactionMessages()       (real SQL, real sqlite driver)
 *   the tab     isTimestampInAuditPeriod()     (src/utils/dateRangeUtils.ts)
 *
 * and requires them to admit exactly the same set. Mutating `auditWindowEnd()`
 * moves the export and the submission together and leaves the tab where it is,
 * so the sets stop matching and every test in section 1 reds at once — which is
 * the property the item asks for.
 *
 * The tab is a MIRROR, not a caller: the renderer cannot value-import from
 * `electron/` (Vite parses it as JavaScript) and `electron/` cannot import from
 * `src/` (rootDir), so `src/utils/dateRangeUtils.ts` implements the same rule
 * independently. Nothing pins two implementations to each other except a corpus
 * that runs both — this file is that corpus.
 *
 * ## Fixtures are LOCAL-relative, and why that matters
 *
 * Every instant here is built from the closing day's LOCAL wall clock
 * (`new Date(2026, 6, 29, h, m, s, ms)`), never from a hardcoded UTC string. A
 * fixed UTC string is a different time of day in every zone, so it can only
 * assert something true in one. Local-relative instants make ONE expectation
 * table correct in every zone, and keep both mutation families detectable in
 * every zone:
 *
 *   - the pre-2788 rule (UTC midnight of the next day) admits `firstout` in UTC
 *     and east of it, and drops `evening` + `lastin` west of it;
 *   - a naive "+24 hours" rule admits `firstout` everywhere, because local
 *     midnight of the next day is the first EXCLUDED instant.
 *
 * DST and the exact per-zone instants cannot be asserted in-process: a jest test
 * cannot change its own timezone (measured — see
 * `tests/support/auditWindowZoneProbe.ts`). Section 4 spawns that probe under fixed
 * zones instead, so a UTC-only CI run still checks the Chicago and Berlin
 * answers, including both DST transition days.
 *
 * Message rows are stored exactly as the real producer writes them —
 * `sentAt.toISOString()` at
 * `electron/services/macOSMessagesImportService/macOSMessagesImportService.ts:1592`,
 * ISO-8601 with `Z` and milliseconds — because the SQL `<= ?` is lexicographic
 * on that string.
 */

import path from "path";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// Module mocks. `submissionDbService` reads `ensureDb`; `messageMatchingService`
// reads `dbAll`. Both live in the same module, so one mock serves both.
// ---------------------------------------------------------------------------
const mockEnsureDb = jest.fn();
const mockDbAll = jest.fn();
jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => mockEnsureDb(),
  dbAll: (...args: unknown[]) => mockDbAll(...args),
  dbRun: jest.fn(),
  dbGet: jest.fn(),
}));

jest.mock("../services/db/communicationDbService", () => ({
  getIgnoredEmailIdsForTransaction: jest.fn(() => []),
  getIgnoredThreadIdsForTransaction: jest.fn(() => []),
  getIgnoredCommunicationIdsForTransaction: jest.fn(() => []),
}));

// Require the REAL native driver (the default Jest moduleNameMapper rewrites it
// to a stub — escape that with an explicit node_modules path).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { auditWindowEnd, resolveExportPlan } from "../services/exportPlan";
import { getTransactionMessages } from "../services/db/submissionDbService";
import { findTextMessagesByPhones } from "../services/messageMatchingService";
import { computeTransactionDateRange, DEFAULT_BUFFER_DAYS } from "../utils/emailDateRange";
import {
  parseLocalCalendarDay,
  isTimestampInAuditPeriod,
} from "../../src/utils/dateRangeUtils";
import type { Communication } from "../types/models";

// ---------------------------------------------------------------------------
// The transaction under test: closed 2026-07-29.
// ---------------------------------------------------------------------------
const CLOSED_AT = "2026-07-29";
const STARTED_AT = "2026-01-01";

/** What submissionService.ts:272 passes down: `new Date(transaction.closed_at)`. */
const auditStart = new Date(STARTED_AT);
const auditEnd = new Date(CLOSED_AT);

/** The closing day, as LOCAL wall-clock parts. */
const CLOSING_DAY: readonly [number, number, number] = [2026, 6, 29];

/** An instant at a given LOCAL wall clock on the closing day (+ `dayOffset` days). */
function localInstant(
  hours: number,
  minutes: number,
  seconds: number,
  ms: number,
  dayOffset = 0,
): string {
  const [y, m, d] = CLOSING_DAY;
  return new Date(y, m, d + dayOffset, hours, minutes, seconds, ms).toISOString();
}

const EARLY_OUT = "2025-12-31T23:59:59.999Z"; // before the audit start -> OUT
const MID_IN = "2026-06-15T12:00:00.000Z"; // comfortably inside -> IN
const DAWN = localInstant(0, 30, 0, 0); // 12:30am local, the closing day (BACKLOG-2781's case)
const EVENING = localInstant(21, 0, 0, 0); // 9pm local, the closing day (the founder's case)
const LAST_IN = localInstant(23, 59, 59, 999); // the last instant of the local closing day
const FIRST_OUT = localInstant(0, 0, 0, 0, 1); // local midnight: already the next day

const SWEEP: ReadonlyArray<readonly [string, string]> = [
  ["early", EARLY_OUT],
  ["mid", MID_IN],
  ["dawn", DAWN],
  ["evening", EVENING],
  ["lastin", LAST_IN],
  ["firstout", FIRST_OUT],
];

/** What the closing day, ending at local midnight, admits. */
const IN_WINDOW = ["mid", "dawn", "evening", "lastin"];

// ---------------------------------------------------------------------------
// The three surfaces, each fed the same sweep.
// ---------------------------------------------------------------------------

/** Surface 1 — the app's exports. */
function exportedKeys(): Set<string> {
  const comms = SWEEP.map(
    ([key, sentAt]) =>
      ({
        id: key,
        sent_at: sentAt,
        communication_type: "sms",
        channel: "sms",
      }) as unknown as Communication,
  );

  return new Set(
    resolveExportPlan(
      {
        format: "folder",
        contentType: "both",
        attachmentType: "all",
        emailMode: "thread",
        startDate: STARTED_AT,
        endDate: CLOSED_AT,
      },
      comms,
    ).communications.map((c) => c.id as string),
  );
}

/** Surface 2 — the broker submission package (real SQL). */
function submittedKeys(): Set<string> {
  return new Set(
    getTransactionMessages("T1", auditStart, auditEnd).map((row) =>
      (row as unknown as { id: string }).id.replace(/^M_/, ""),
    ),
  );
}

/** Surface 3 — what the Texts tab shows as in-period. */
function tabKeys(): Set<string> {
  const start = parseLocalCalendarDay(STARTED_AT);
  const end = parseLocalCalendarDay(CLOSED_AT);
  return new Set(
    SWEEP.filter(([, sentAt]) => isTimestampInAuditPeriod(sentAt, start, end)).map(([key]) => key),
  );
}

function createSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      sent_at DATETIME,
      direction TEXT,
      participants_flat TEXT
    );
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      sent_at DATETIME,
      direction TEXT,
      subject TEXT,
      sender TEXT
    );
    CREATE TABLE communications (
      id TEXT PRIMARY KEY,
      transaction_id TEXT,
      message_id TEXT,
      email_id TEXT,
      thread_id TEXT
    );
  `);
}

function seed(db: DatabaseType): void {
  const message = db.prepare(
    `INSERT INTO messages (id, thread_id, sent_at, direction, participants_flat) VALUES (?, ?, ?, ?, ?)`,
  );
  const comm = db.prepare(
    `INSERT INTO communications (id, transaction_id, message_id, email_id, thread_id) VALUES (?, ?, ?, ?, ?)`,
  );

  for (const [key, sentAt] of SWEEP) {
    message.run(`M_${key}`, `TH_${key}`, sentAt, "inbound", "+15555550100");
    comm.run(`cm_${key}`, "T1", `M_${key}`, null, `TH_${key}`);
  }
}

// ===========================================================================
// 1. The founder's walk-through, through all three surfaces at once.
// ===========================================================================
describe("BACKLOG-2788 — the closing day, seen from the agent's eyes", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as DatabaseType;
    createSchema(db);
    seed(db);
    mockEnsureDb.mockReturnValue(db);
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
  });

  it("the 9pm-local text on the closing day is in the export, the submission AND the tab", () => {
    const exported = exportedKeys();
    const submitted = submittedKeys();
    const shown = tabKeys();

    // The reported case: present on all three surfaces, not just the tab.
    expect(exported.has("evening")).toBe(true);
    expect(submitted.has("evening")).toBe(true);
    expect(shown.has("evening")).toBe(true);

    // ...and the three surfaces admit exactly the same set, not merely overlap.
    expect(exported).toEqual(new Set(IN_WINDOW));
    expect(submitted).toEqual(new Set(IN_WINDOW));
    expect(shown).toEqual(new Set(IN_WINDOW));
  });

  it("all three surfaces agree at BOTH edges of the boundary", () => {
    const exported = exportedKeys();
    const submitted = submittedKeys();
    const shown = tabKeys();

    for (const [surface, set] of [
      ["export", exported],
      ["submission", submitted],
      ["tab", shown],
    ] as const) {
      // The last instant of the local closing day is IN...
      expect([surface, set.has("lastin")]).toEqual([surface, true]);
      // ...and local midnight is already the next day, so it is OUT.
      expect([surface, set.has("firstout")]).toEqual([surface, false]);
      // The BACKLOG-2781 case (12:30am local on the closing day) stays in.
      expect([surface, set.has("dawn")]).toEqual([surface, true]);
      // The audit START is untouched by this change.
      expect([surface, set.has("early")]).toEqual([surface, false]);
    }
  });

  it("the export and the submission cannot drift from the tab without this suite reddening", () => {
    // Stated as set identity rather than three separate expectations, because
    // the failure this guards against is DIVERGENCE, not a wrong absolute value.
    expect(exportedKeys()).toEqual(tabKeys());
    expect(submittedKeys()).toEqual(tabKeys());
  });
});

// ===========================================================================
// 2. The boundary instant itself.
// ===========================================================================
describe("BACKLOG-2788 — auditWindowEnd is a local-midnight boundary", () => {
  it("is the last millisecond before LOCAL midnight of the closing day", () => {
    const bound = auditWindowEnd(CLOSED_AT)!;

    expect([bound.getFullYear(), bound.getMonth(), bound.getDate()]).toEqual([2026, 6, 29]);
    expect([
      bound.getHours(),
      bound.getMinutes(),
      bound.getSeconds(),
      bound.getMilliseconds(),
    ]).toEqual([23, 59, 59, 999]);

    const nextInstant = new Date(bound.getTime() + 1);
    expect([
      nextInstant.getDate(),
      nextInstant.getHours(),
      nextInstant.getMinutes(),
      nextInstant.getSeconds(),
      nextInstant.getMilliseconds(),
    ]).toEqual([30, 0, 0, 0, 0]);
  });

  it("gives the same instant for the date string and the Date the callers parse from it", () => {
    // submissionService.ts:272 passes `new Date(transaction.closed_at)`; the
    // export handlers pass the string. Both must name the same day.
    expect(auditWindowEnd(auditEnd)?.getTime()).toBe(auditWindowEnd(CLOSED_AT)?.getTime());
  });

  it("normalizes a time-bearing value to its calendar day instead of carrying the time forward", () => {
    // BACKLOG-2781 SR follow-up C: the pre-2788 helper advanced the whole
    // instant by a day, so a `closed_at` carrying a time shipped a broker
    // submission communications from AFTER the closing day. No writer in the app
    // produces one (`closed_at` is validated against /^\d{4}-\d{2}-\d{2}/ at
    // electron/utils/validation.ts:709), so this is a latent-shape guard.
    expect(auditWindowEnd("2026-07-29 12:00:00")?.getTime()).toBe(
      auditWindowEnd(CLOSED_AT)?.getTime(),
    );
    expect(auditWindowEnd("2026-07-29T12:00:00.000Z")?.getTime()).toBe(
      auditWindowEnd(CLOSED_AT)?.getTime(),
    );
  });

  it("keeps its pre-2788 handling of empty and unparseable input", () => {
    // Unchanged on purpose. `null` means "no upper bound"; an unparseable value
    // must NOT collapse into that meaning — a corrupt `closed_at` reading as
    // open-ended is the confusion importPlan.ts:329-341 exists to prevent — so
    // it stays an Invalid Date and fails loudly in the SQL callers.
    expect(auditWindowEnd(null)).toBeNull();
    expect(auditWindowEnd(undefined)).toBeNull();
    expect(auditWindowEnd("")).toBeNull();
    expect(auditWindowEnd("garbage")?.getTime()).toBeNaN();
    expect(auditWindowEnd("2026-13-40")?.getTime()).toBeNaN();
    expect(auditWindowEnd(new Date("garbage"))?.getTime()).toBeNaN();
  });
});

// ===========================================================================
// 3. Unification: the other closing-day bounds derive from the same helper.
// ===========================================================================
describe("BACKLOG-2788 — every closing-day bound derives from the one helper", () => {
  beforeEach(() => {
    mockDbAll.mockReset();
    mockDbAll.mockReturnValue([]);
  });

  /** The end-bound parameter `findTextMessagesByPhones` binds into its SQL. */
  async function autoLinkEndBound(endDate: string): Promise<string> {
    await findTextMessagesByPhones(
      "user-1",
      [{ contactId: "c1", phone: "+15555550100" }],
      "T1",
      { endDate },
    );

    expect(mockDbAll).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbAll.mock.calls[0] as [string, string[]];
    expect(sql).toContain("m.sent_at <= ?");
    // The bound is the LAST parameter: the date filter is appended after the
    // ignored-communications params.
    return params[params.length - 1];
  }

  it("auto-link matching binds the same instant the export does", async () => {
    const bound = await autoLinkEndBound(CLOSED_AT);

    expect(bound).toBe(auditWindowEnd(CLOSED_AT)!.toISOString());
    // Independently of the helper: it is the end of the LOCAL closing day.
    expect(new Date(bound).getHours()).toBe(23);
    expect(new Date(bound).getDate()).toBe(29);
  });

  it("auto-link no longer builds its bound by string concatenation", async () => {
    // The pre-2788 site was `options.endDate + "T23:59:59.999Z"`. For a
    // time-bearing end date that produced "…T12:00:00.000ZT23:59:59.999Z" — a
    // malformed string that the lexicographic SQL `<=` compares happily and
    // silently mis-filters (BACKLOG-2781 SR follow-up D). Re-inlining the
    // literal reds this in EVERY zone; re-inlining it reds the assertion above
    // in every zone but UTC, where end-of-UTC-day and end-of-local-day coincide.
    const bound = await autoLinkEndBound("2026-07-29T12:00:00.000Z");

    expect(Number.isNaN(new Date(bound).getTime())).toBe(false);
    expect(bound).toBe(auditWindowEnd(CLOSED_AT)!.toISOString());
  });

  it("the email/import window buffers from the end of the local closing day", () => {
    const { end } = computeTransactionDateRange({ closed_at: CLOSED_AT });

    const expected = auditWindowEnd(CLOSED_AT)!;
    expected.setDate(expected.getDate() + DEFAULT_BUFFER_DAYS);
    expect(end.getTime()).toBe(expected.getTime());

    // Independently of the helper: 2026-07-29 + 30 days = 2026-08-28, and the
    // window runs to the end of that day rather than to its start.
    expect([end.getFullYear(), end.getMonth(), end.getDate()]).toEqual([2026, 7, 28]);
    expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([
      23, 59, 59, 999,
    ]);
  });
});

// ===========================================================================
// 4. The zones this process is not running in — including both DST days.
// ===========================================================================
describe("BACKLOG-2788 — the bound in timezones this process cannot enter", () => {
  interface ZoneReport {
    zone: string;
    julyOffsetMinutes: number;
    januaryOffsetMinutes: number;
    bounds: Record<string, string>;
    boundLocalParts: Record<string, number[]>;
    tabAtBound: Record<string, boolean>;
    tabPastBound: Record<string, boolean>;
    emailRangeEnd: string;
  }

  /**
   * Runs the boundary modules in a child process pinned to `tz`.
   *
   * A test cannot do this in-process: V8 caches the zone per context and jest
   * hands tests a COPY of `process.env`, so assigning `process.env.TZ` mid-run
   * changes nothing (measured 2026-08-22 under both the node and the electron
   * jest runners). `TZ` in the environment AT STARTUP is honored by both.
   *
   * `ELECTRON_RUN_AS_NODE` makes this work when the suite itself is running
   * under the electron runner (the local way to reach the real sqlite driver);
   * under plain node it is ignored.
   */
  const zoneCache = new Map<string, ZoneReport>();

  function runInZone(tz: string): ZoneReport {
    // Memoized: one child per zone per file. Each spawn pays a ts-node
    // transpile, and a test that spawned three of them could brush the default
    // 5s jest timeout on a cold Windows runner.
    const cached = zoneCache.get(tz);
    if (cached) return cached;

    const stdout = execFileSync(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        path.join(__dirname, "..", "..", "tests", "support", "auditWindowZoneProbe.ts"),
      ],
      {
        env: {
          ...process.env,
          TZ: tz,
          ELECTRON_RUN_AS_NODE: "1",
          TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs" }),
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    const report = JSON.parse(stdout) as ZoneReport;
    // The pin has to have taken, or every expectation below is vacuous. Dropping
    // `TZ` from the child env reds all six tests in this section with the
    // machine's own zone named in the message — verified 2026-08-22.
    expect(report.zone).toBe(tz);
    zoneCache.set(tz, report);
    return report;
  }

  /** Generous, because the first spawn in a cold CI container pays for ts-node. */
  const ZONE_TIMEOUT_MS = 120_000;

  /**
   * Measured 2026-08-22 by running the probe under each zone. These are the
   * instants the founder's contract names, written out rather than recomputed:
   * an expectation the code under test derives is not an expectation.
   */
  it("UTC: the day ends at 23:59:59.999Z, and the old bound's instant is out", () => {
    const report = runInZone("UTC");

    expect(report.bounds["2026-07-29"]).toBe("2026-07-29T23:59:59.999Z");
    // The pre-2788 bound was 2026-07-30T00:00:00.000Z — one millisecond later,
    // and a day the user never worked. That instant is now excluded.
    expect(report.tabPastBound["2026-07-29"]).toBe(false);
  }, ZONE_TIMEOUT_MS);

  it("America/Chicago: the closing EVENING is inside the window (the founder's case)", () => {
    const report = runInZone("America/Chicago");

    // 11:59:59.999pm local on the closing day. The pre-2788 bound was
    // 2026-07-30T00:00:00.000Z = 7:00pm local, which is the 5 hours the item
    // was filed about.
    expect(report.bounds["2026-07-29"]).toBe("2026-07-30T04:59:59.999Z");

    // The reported text — 9pm local, 2026-07-30T02:00Z — sits inside that bound.
    expect(new Date("2026-07-30T02:00:00.000Z").getTime()).toBeLessThan(
      new Date(report.bounds["2026-07-29"]).getTime(),
    );
  }, ZONE_TIMEOUT_MS);

  it("America/Chicago: both DST days land on the real local midnight", () => {
    const report = runInZone("America/Chicago");

    // Spring forward — the local day is 23 hours long, so a naive +24h bound
    // would land at 2026-03-09T06:00Z, an hour INTO the next local day.
    expect(report.bounds["2026-03-08"]).toBe("2026-03-09T04:59:59.999Z");

    // Fall back — the local day is 25 hours long, so a naive +24h bound would
    // land at 2026-11-02T05:00Z and cut the last local hour off the day.
    expect(report.bounds["2026-11-01"]).toBe("2026-11-02T05:59:59.999Z");

    // Both are 23:59:59.999 on the closing day by the local clock, which is the
    // property; the instants above are what it comes to in this zone.
    expect(report.boundLocalParts["2026-03-08"]).toEqual([2026, 2, 8, 23, 59, 59, 999]);
    expect(report.boundLocalParts["2026-11-01"]).toEqual([2026, 10, 1, 23, 59, 59, 999]);
    expect(report.julyOffsetMinutes).toBe(300); // CDT
    expect(report.januaryOffsetMinutes).toBe(360); // CST
  }, ZONE_TIMEOUT_MS);

  it("Europe/Berlin: east of UTC the bound moves EARLIER, not later", () => {
    const report = runInZone("Europe/Berlin");

    // The pre-2788 bound (2026-07-30T00:00:00.000Z) was 2am on the day AFTER
    // closing here — it swept in communications from a day the deal was closed.
    expect(report.bounds["2026-07-29"]).toBe("2026-07-29T21:59:59.999Z");
    expect(report.bounds["2026-03-08"]).toBe("2026-03-08T22:59:59.999Z");
  }, ZONE_TIMEOUT_MS);

  it("in every zone the Texts tab agrees with the helper at the boundary", () => {
    for (const tz of ["UTC", "America/Chicago", "Europe/Berlin"]) {
      const report = runInZone(tz);
      for (const day of ["2026-07-29", "2026-03-08", "2026-11-01"]) {
        // The bound is in-period for the tab...
        expect([tz, day, report.tabAtBound[day]]).toEqual([tz, day, true]);
        // ...and one millisecond later is not. Two implementations of one rule,
        // pinned to the same millisecond, on the DST days too.
        expect([tz, day, report.tabPastBound[day]]).toEqual([tz, day, false]);
      }
    }
  }, ZONE_TIMEOUT_MS);

  it("the email/import window ends with the buffered local day in every zone", () => {
    // 2026-07-29 + 30 days = 2026-08-28, ending at that day's local midnight.
    expect(runInZone("UTC").emailRangeEnd).toBe("2026-08-28T23:59:59.999Z");
    expect(runInZone("America/Chicago").emailRangeEnd).toBe("2026-08-29T04:59:59.999Z");
    expect(runInZone("Europe/Berlin").emailRangeEnd).toBe("2026-08-28T21:59:59.999Z");
  }, ZONE_TIMEOUT_MS);
});
