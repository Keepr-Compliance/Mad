/**
 * BACKLOG-2914 — THE OUTCOME ROW REACHES POSTGRES.
 *
 * The second sink. Sentry answers "did this release break something"; this table is
 * where BACKLOG-2894's per-phase duration model gets fitted, months from now, against
 * a corpus that has to start accumulating NOW because a run that is not recorded is
 * gone forever.
 *
 * The load-bearing controls here are the ones about NOT breaking a sync. This code
 * runs at the end of an operation that can take a user an hour, and the founder is in
 * a live sync-testing loop. A telemetry write that can fail that is worse than no
 * telemetry write at all.
 */

import {
  recordSyncOutcome,
  buildSyncOutcomeRow,
  SYNC_OUTCOMES_TABLE,
} from "../syncOutcomeSupabase";
import { SyncTimeline, SYNC_OUTCOME_SOURCE } from "../syncTimeline";
import type { SyncOutcomeRow } from "../syncTimeline";
import supabaseService from "../supabaseService";

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: jest.fn() },
}));

const getClient = (supabaseService as unknown as { getClient: jest.Mock }).getClient;

let insert: jest.Mock;
let from: jest.Mock;

/** A client shaped like the real one: authed session, chainable `.from().insert()`. */
function mockClient(opts: { userId?: string | null; insertResult?: unknown } = {}) {
  const { userId = "user-123", insertResult = { error: null } } = opts;
  insert = jest.fn().mockResolvedValue(insertResult);
  from = jest.fn(() => ({ insert }));
  return {
    auth: {
      getSession: jest
        .fn()
        .mockResolvedValue({ data: { session: userId ? { user: { id: userId } } : null } }),
    },
    from,
  };
}

/** Let the fire-and-forget write run to completion. */
const flush = () =>
  new Promise((r) => {
    // NOT setImmediate: jest.config.js runs this suite under jest-environment-jsdom,
    // where it is undefined. A macrotask tick is what the detached .catch needs.
    setTimeout(r, 0);
  });

function realisticRow(overrides: Partial<SyncOutcomeRow> = {}): SyncOutcomeRow {
  return {
    source: SYNC_OUTCOME_SOURCE,
    outcome: "complete",
    elapsedMs: 3_120_000,
    phases: [
      { phase: "backup:waiting-for-device", elapsedMs: 480_000 },
      { phase: "backup:transferring", elapsedMs: 2_400_000 },
    ],
    fields: {
      source: SYNC_OUTCOME_SOURCE,
      outcome: "complete",
      elapsedMs: 3_120_000,
      platform: "darwin",
      deviceModel: "iPhone14,3",
      deviceIosVersion: "18.5",
      deviceUsedBytes: 61_200_000_000,
      hostOsRelease: "24.6.0",
      hostTotalMemBytes: 17_179_869_184,
      priorBackup: "exists",
      backupModeSource: "device-reported",
      incremental: false,
      messagesExtracted: 663_722,
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getClient.mockReturnValue(mockClient());
});

describe("BACKLOG-2914: a successful sync writes a row — the denominator", () => {
  it("inserts one row into sync_outcomes for a COMPLETE sync", async () => {
    recordSyncOutcome(realisticRow());
    await flush();
    expect(from).toHaveBeenCalledWith(SYNC_OUTCOMES_TABLE);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].outcome).toBe("complete");
  });

  it.each(["complete", "cancelled", "error"] as const)("inserts for outcome=%s", async (o) => {
    recordSyncOutcome(realisticRow({ outcome: o }));
    await flush();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].outcome).toBe(o);
  });

  it("attributes the row to the authenticated user, as RLS requires", async () => {
    recordSyncOutcome(realisticRow());
    await flush();
    expect(insert.mock.calls[0][0].user_id).toBe("user-123");
  });
});

describe("BACKLOG-2914: the row carries what the duration model needs", () => {
  it("maps the row onto the table's columns in snake_case", () => {
    const r = buildSyncOutcomeRow(realisticRow(), "user-123", {
      appVersion: "2.31.0",
      platform: "darwin",
      isPackaged: true,
    });
    expect(r.source).toBe(SYNC_OUTCOME_SOURCE);
    expect(r.elapsed_ms).toBe(3_120_000);
    expect(r.device_model).toBe("iPhone14,3");
    expect(r.device_ios_version).toBe("18.5");
    expect(r.host_total_mem_bytes).toBe(17_179_869_184);
    expect(r.prior_backup).toBe("exists");
    expect(r.backup_mode_source).toBe("device-reported");
    expect(r.incremental).toBe(false);
    expect(r.messages_extracted).toBe(663_722);
    expect(r.app_version).toBe("2.31.0");
    expect(r.is_packaged).toBe(true);
  });

  /**
   * The phases column is jsonb and an ARRAY because `enter()` creates a NEW record
   * when a phase is re-entered. A keyed object would silently collapse the second
   * `storing:messages` into the first and lose the ordering with it.
   */
  it("stores phases as an ordered array that survives a re-entered phase", () => {
    const row = realisticRow({
      phases: [
        { phase: "storing:messages", elapsedMs: 1000 },
        { phase: "parsing", elapsedMs: 50 },
        { phase: "storing:messages", elapsedMs: 2000 },
      ],
    });
    expect(buildSyncOutcomeRow(row, "u", {}).phases).toEqual([
      { phase: "storing:messages", elapsed_ms: 1000 },
      { phase: "parsing", elapsed_ms: 50 },
      { phase: "storing:messages", elapsed_ms: 2000 },
    ]);
  });

  /** Absent stays absent: a value that was not established must not become null-ish noise. */
  it("omits a column the run never established", () => {
    const row = realisticRow();
    delete row.fields.deviceModel;
    const r = buildSyncOutcomeRow(row, "u", {});
    expect(r).not.toHaveProperty("device_model");
    expect(r).toHaveProperty("device_ios_version");
  });
});

describe("BACKLOG-2914: NO PII reaches durable storage", () => {
  /**
   * THE FIXTURE HAS BOTH AVAILABLE TO LEAK — a UDID and a personal-nickname device
   * name, plus a serial and a home-directory path. A fixture without them could not
   * fail this test and would prove nothing.
   *
   * This matters more here than for Sentry: this is the founder's own database and
   * the rows are durable.
   */
  const leaky = {
    udid: "00008030-001A2C3E1E88802E",
    deviceName: "Danny Boy's iPhone",
    serialNumber: "F2LX93KJQ1GH",
    // `testuser` IS THE POINT. BACKLOG-2657 records a real developer home directory
    // still sitting in a fixture on `main`, and this repo is PUBLIC. The PII pre-push
    // scan does NOT catch username-in-path, so nothing but this comment stops the next
    // person pasting their own `/Users/<name>` here. Never a real one.
    backupPath: "/Users/testuser/Library/Application Support/keepr/backup",
  };

  it("writes neither the UDID nor the device name, from a row carrying both", async () => {
    const row = realisticRow();
    Object.assign(row.fields, leaky);
    recordSyncOutcome(row);
    await flush();

    const payload = JSON.stringify(insert.mock.calls[0][0]);
    expect(payload).not.toContain("00008030-001A2C3E1E88802E");
    expect(payload).not.toContain("Danny Boy");
    expect(payload).not.toContain("F2LX93KJQ1GH");
    expect(payload).not.toContain("/Users/testuser");
    // the fixture really did carry them, so this test could have failed
    expect(JSON.stringify(row.fields)).toContain("00008030-001A2C3E1E88802E");
    expect(JSON.stringify(row.fields)).toContain("Danny Boy");
    // and the legitimate device fact still travels
    expect(insert.mock.calls[0][0].device_model).toBe("iPhone14,3");
  });

  it("copies only named columns, so an unknown future field cannot reach the table", () => {
    const row = realisticRow();
    row.fields.someFutureDimension = "whatever-2952-adds";
    const r = buildSyncOutcomeRow(row, "u", {});
    expect(JSON.stringify(r)).not.toContain("whatever-2952-adds");
  });
});

describe("BACKLOG-2914: the write NEVER affects the sync", () => {
  it("does not throw when the Supabase client is unavailable (signed out / dev)", () => {
    getClient.mockImplementation(() => {
      throw new Error("Supabase client not initialized");
    });
    expect(() => recordSyncOutcome(realisticRow())).not.toThrow();
  });

  it("does not throw or reject when the insert fails (offline)", async () => {
    const rejection = jest.fn();
    process.on("unhandledRejection", rejection);
    getClient.mockReturnValue({
      auth: { getSession: jest.fn().mockResolvedValue({ data: { session: { user: { id: "u" } } } }) },
      from: () => ({ insert: jest.fn().mockRejectedValue(new Error("network unreachable")) }),
    });
    expect(() => recordSyncOutcome(realisticRow())).not.toThrow();
    await flush();
    expect(rejection).not.toHaveBeenCalled();
    process.off("unhandledRejection", rejection);
  });

  it("does not throw when Supabase returns a row-level error (RLS refusal)", async () => {
    getClient.mockReturnValue(mockClient({ insertResult: { error: { message: "RLS denied" } } }));
    expect(() => recordSyncOutcome(realisticRow())).not.toThrow();
    await flush();
  });

  /** OFFLINE IS THE NORMAL CASE. Dropped, not queued, and never pretended sent. */
  it("drops the row rather than queueing it when there is no session", async () => {
    getClient.mockReturnValue(mockClient({ userId: null }));
    recordSyncOutcome(realisticRow());
    await flush();
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns synchronously — nothing on the sync's critical path can await it", () => {
    expect(recordSyncOutcome(realisticRow())).toBeUndefined();
  });
});

describe("BACKLOG-2914: THE WIRING — the real timeline reaches Supabase", () => {
  /**
   * As with the Sentry half: every test above calls the writer directly and would
   * pass on a module wired to nothing. This drives a `SyncTimeline` with NO reporter
   * injected — production wiring — and reds if the Supabase sink is unwired.
   */
  it("inserts a row from an un-injected SyncTimeline on endSync", async () => {
    const timeline = new SyncTimeline({ sink: () => {} });
    timeline.beginSync({ platform: "darwin" });
    timeline.setContext({ deviceModel: "iPhone14,3", priorBackup: "exists" });
    timeline.enter("backup:transferring");
    timeline.endSync("complete", { messagesExtracted: 663_722 });
    await flush();

    expect(from).toHaveBeenCalledWith(SYNC_OUTCOMES_TABLE);
    const payload = insert.mock.calls[0][0];
    expect(payload.outcome).toBe("complete");
    expect(payload.source).toBe(SYNC_OUTCOME_SOURCE);
    expect(payload.device_model).toBe("iPhone14,3");
    expect(payload.messages_extracted).toBe(663_722);
    expect(payload.phases).toEqual([{ phase: "backup:transferring", elapsed_ms: expect.any(Number) }]);
  });

  /** One sink failing must not cost the other. */
  it("still reaches Supabase when the Sentry sink throws", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/electron/main");
    (Sentry.captureMessage as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    const timeline = new SyncTimeline({ sink: () => {} });
    timeline.beginSync();
    timeline.endSync("complete");
    await flush();
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
