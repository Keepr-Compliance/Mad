/**
 * BACKLOG-3816 telemetry: backup-encryption facts ride in `source_metrics` (no new
 * column, no migration), allow-listed by VALUE, and never carry password material.
 */
jest.mock("../supabaseService", () => ({ __esModule: true, default: { getClient: jest.fn() } }));

import { buildSyncOutcomeRow } from "../syncOutcomeSupabase";
import { SYNC_OUTCOME_SOURCE, type SyncOutcomeRow } from "../syncTimeline";

function row(fields: Record<string, string | number | boolean>, extra: Partial<SyncOutcomeRow> = {}): SyncOutcomeRow {
  return {
    runId: "run-3816-telemetry-test",
    startedAt: 1_760_000_000_000,
    source: SYNC_OUTCOME_SOURCE,
    outcome: "error",
    elapsedMs: 1000,
    phases: [],
    fields: { source: SYNC_OUTCOME_SOURCE, outcome: "error", ...fields },
    ...extra,
  } as SyncOutcomeRow;
}

describe("BACKLOG-3816 backup-encryption telemetry", () => {
  it("records where the password came from, the phone's setting and the enable result", () => {
    const r = buildSyncOutcomeRow(
      row({
        backupPassword: "provided",
        phoneBackupEncryption: "on",
        encryptionEnable: "not-confirmed",
        reasonCode: "ENCRYPTION_NOT_CONFIRMED",
        endedBy: "backup-encryption",
      }),
      "u",
    );
    expect(r.source_metrics).toEqual({
      backupPassword: "provided",
      phoneBackupEncryption: "on",
      encryptionEnable: "not-confirmed",
    });
    expect(r.reason_code).toBe("ENCRYPTION_NOT_CONFIRMED");
    expect(r.ended_by).toBe("backup-encryption");
  });

  it("drops any value outside the allow-list — a password can never ride along", () => {
    const r = buildSyncOutcomeRow(row({ backupPassword: "hunter2-secret", phoneBackupEncryption: "maybe" }), "u");
    expect(r).not.toHaveProperty("source_metrics");
    expect(JSON.stringify(r)).not.toContain("hunter2-secret");
  });

  it("a source's own metrics (Google Messages) are never replaced", () => {
    const r = buildSyncOutcomeRow(row({ backupPassword: "stored" }, { sourceMetrics: { rcs: 1 } }), "u");
    expect(r.source_metrics).toEqual({ rcs: 1 });
  });
});
