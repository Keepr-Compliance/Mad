/**
 * BACKLOG-3598 — the telemetry writer tolerates the two leftover-cleanup columns
 * being absent from `sync_outcomes` (desktop build ahead of the migration).
 *
 * Without the tolerance, PostgREST refuses every write carrying an unknown key, so a
 * run that removed a leftover loses its heartbeats and its terminal row, and the row
 * stays `running`. The tolerance must be NARROW: only an unknown-column error that
 * names one of the two columns is retried; anything else still fails the write.
 *
 * Error fixtures are the RESOLVED shape postgrest-js returns (it parses the response
 * body into `error`, keeping PostgREST's `code`). The PGRST204 message template is
 * PostgREST's "Could not find the '<col>' column of '<table>' in the schema cache" —
 * cited, not measured against production (production is read-only from here).
 */

import log from "electron-log";
import {
  recordSyncOutcome,
  recordSyncRunProgress,
  recordSyncRunProgressWhileRunning,
  __resetLeftoverColumnsForTests,
} from "../syncOutcomeSupabase";
import { SYNC_OUTCOME_SOURCE } from "../syncTimeline";
import type { SyncOutcomeRow } from "../syncTimeline";
import supabaseService from "../supabaseService";

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: jest.fn() },
}));
jest.mock("electron-log", () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const getClient = (supabaseService as unknown as { getClient: jest.Mock }).getClient;
const warn = (log as unknown as { warn: jest.Mock }).warn;

const OK = { data: null, error: null, status: 201 };
function pgError(code: string, message: string) {
  return { data: null, error: { code, message, details: null, hint: null }, status: 400 };
}
const MISSING_LEFTOVER = pgError(
  "PGRST204",
  "Could not find the 'leftover_backup_bytes_cleared' column of 'sync_outcomes' in the schema cache",
);

let upsert: jest.Mock;
let update: jest.Mock;
let eq: jest.Mock;
let from: jest.Mock;

/** Each verb answers from its own queue; the last answer repeats. */
function mockClient(answers: { upsert?: unknown[]; update?: unknown[] } = {}) {
  const queue = (list: unknown[] = [OK]) => {
    let i = 0;
    return () => Promise.resolve(list[Math.min(i++, list.length - 1)]);
  };
  const nextUpsert = queue(answers.upsert);
  const nextUpdate = queue(answers.update);
  upsert = jest.fn(() => nextUpsert());
  // `.update(p).eq(...)` and `.update(p).eq(...).eq(...)`: a thenable that also chains.
  eq = jest.fn(() => {
    const p = nextUpdate();
    return { then: p.then.bind(p), eq };
  });
  update = jest.fn(() => ({ eq }));
  from = jest.fn(() => ({ upsert, update }));
  return {
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: { user: { id: "user-123" } } } }),
    },
    from,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// pii-allow-uuid: invented sync run id, typed by hand for this fixture
const RUN_ID = "7d2f0a4c-61b8-4e3d-9c5a-0e1b2f3a4d5c";

function rowWithLeftover(overrides: Partial<SyncOutcomeRow> = {}): SyncOutcomeRow {
  return {
    runId: RUN_ID,
    startedAt: Date.UTC(2026, 9, 7, 9, 0, 0),
    source: SYNC_OUTCOME_SOURCE,
    outcome: "complete",
    elapsedMs: 600_000,
    phases: [{ phase: "backup:transferring", elapsedMs: 500_000 }],
    fields: {
      source: SYNC_OUTCOME_SOURCE,
      outcome: "complete",
      elapsedMs: 600_000,
      platform: "win32",
      deviceModel: "iPhone14,3",
      messagesExtracted: 1_234,
      leftoverBackupBytesCleared: 81_604_378_624,
      leftoverCleanup: "removed",
    },
    ...overrides,
  };
}

const LEFTOVER_KEYS = ["leftover_backup_bytes_cleared", "leftover_cleanup"];
const sortedKeys = (o: Record<string, unknown>) => Object.keys(o).sort();

beforeEach(() => {
  jest.clearAllMocks();
  __resetLeftoverColumnsForTests();
});

describe("BACKLOG-3598: columns absent — the row is still written, without them", () => {
  it("retries the terminal row once without the two columns and keeps every other key", async () => {
    getClient.mockReturnValue(mockClient({ upsert: [MISSING_LEFTOVER, OK] }));

    recordSyncOutcome(rowWithLeftover());
    await flush();

    expect(upsert).toHaveBeenCalledTimes(2);
    const first = upsert.mock.calls[0][0] as Record<string, unknown>;
    const retry = upsert.mock.calls[1][0] as Record<string, unknown>;
    expect(first.leftover_cleanup).toBe("removed");
    for (const k of LEFTOVER_KEYS) expect(retry).not.toHaveProperty(k);
    expect(sortedKeys(retry)).toEqual(sortedKeys(first).filter((k) => !LEFTOVER_KEYS.includes(k)));
    expect(retry.outcome).toBe("complete");
    // The write did NOT fail: no "row dropped" warning.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("row dropped"))).toBe(false);
  });

  it("after learning, heartbeats go out stripped on the FIRST attempt and keep flowing", async () => {
    getClient.mockReturnValue(mockClient({ upsert: [MISSING_LEFTOVER, OK], update: [OK] }));

    recordSyncOutcome(rowWithLeftover());
    await flush();
    recordSyncRunProgress(rowWithLeftover({ outcome: "running" }));
    await flush();
    recordSyncRunProgressWhileRunning(rowWithLeftover({ outcome: "running" }));
    await flush();

    // One update per heartbeat — no failed probe first.
    expect(update).toHaveBeenCalledTimes(2);
    for (const call of update.mock.calls) {
      for (const k of LEFTOVER_KEYS) expect(call[0]).not.toHaveProperty(k);
      expect(call[0].device_model).toBe("iPhone14,3");
    }
    // Logged once, not per write.
    const notices = warn.mock.calls.filter((c) => String(c[0]).includes("no leftover-cleanup columns"));
    expect(notices).toHaveLength(1);
  });

  it("a heartbeat that is the first to hit the missing column is retried and lands", async () => {
    getClient.mockReturnValue(mockClient({ update: [MISSING_LEFTOVER, OK] }));

    recordSyncRunProgress(rowWithLeftover({ outcome: "running" }));
    await flush();

    expect(update).toHaveBeenCalledTimes(2);
    for (const k of LEFTOVER_KEYS) expect(update.mock.calls[1][0]).not.toHaveProperty(k);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("row dropped"))).toBe(false);
  });
});

describe("BACKLOG-3598: every other error still fails the write", () => {
  it("an RLS error (42501) is not retried and is reported as dropped", async () => {
    getClient.mockReturnValue(
      mockClient({ upsert: [pgError("42501", "new row violates row-level security policy")] }),
    );

    recordSyncOutcome(rowWithLeftover());
    await flush();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("row dropped"))).toBe(true);
  });

  it("an error NAMING a leftover column but not 'unknown column' (column privilege) is not retried", async () => {
    getClient.mockReturnValue(
      mockClient({ upsert: [pgError("42501", "permission denied for column leftover_cleanup")] }),
    );

    recordSyncOutcome(rowWithLeftover());
    await flush();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("row dropped"))).toBe(true);
  });

  it("an unknown-column error for a DIFFERENT column is not retried", async () => {
    getClient.mockReturnValue(
      mockClient({
        upsert: [
          pgError(
            "PGRST204",
            "Could not find the 'device_model' column of 'sync_outcomes' in the schema cache",
          ),
        ],
      }),
    );

    recordSyncOutcome(rowWithLeftover());
    await flush();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("row dropped"))).toBe(true);
    // And nothing was learned: the next write still carries the columns.
    getClient.mockReturnValue(mockClient());
    recordSyncOutcome(rowWithLeftover());
    await flush();
    expect(upsert.mock.calls[0][0].leftover_cleanup).toBe("removed");
  });

  it("a failure on the stripped retry is reported, not swallowed", async () => {
    getClient.mockReturnValue(
      mockClient({ upsert: [MISSING_LEFTOVER, pgError("57014", "canceling statement due to statement timeout")] }),
    );

    recordSyncOutcome(rowWithLeftover());
    await flush();

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("row dropped"))).toBe(true);
  });
});
