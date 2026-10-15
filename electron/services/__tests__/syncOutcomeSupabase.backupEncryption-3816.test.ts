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
  it("records where the password came from and the phone's setting", () => {
    const r = buildSyncOutcomeRow(
      row({
        backupPassword: "provided",
        phoneBackupEncryption: "on",
        reasonCode: "INCORRECT_PASSWORD",
        endedBy: "backup-encryption",
      }),
      "u",
    );
    expect(r.source_metrics).toEqual({
      backupPassword: "provided",
      phoneBackupEncryption: "on",
    });
    expect(r.reason_code).toBe("INCORRECT_PASSWORD");
    expect(r.ended_by).toBe("backup-encryption");
  });

  it("drops any value outside the allow-list — a password can never ride along", () => {
    const r = buildSyncOutcomeRow(row({ backupPassword: "hunter2-secret", phoneBackupEncryption: "maybe" }), "u");
    expect(r).not.toHaveProperty("source_metrics");
    expect(JSON.stringify(r)).not.toContain("hunter2-secret");
  });

  it("records what happened to the old unencrypted chain (oldChain), allow-listed", () => {
    for (const oldChain of ["aside", "deleted-for-space", "kept"]) {
      expect(buildSyncOutcomeRow(row({ oldChain }), "u").source_metrics).toEqual({ oldChain });
    }
    expect(buildSyncOutcomeRow(row({ oldChain: "deleted" }), "u")).not.toHaveProperty("source_metrics");
  });

  it("BACKLOG-3817 B3: attachments the decrypt could not read are a count on the row", () => {
    const r = buildSyncOutcomeRow(row({ attachmentsUndecryptable: 3, reasonCode: "DECRYPTION_FAILED" }), "u");
    expect(r.source_metrics).toEqual({ attachmentsUndecryptable: 3 });
    expect(r.reason_code).toBe("DECRYPTION_FAILED");
    expect(buildSyncOutcomeRow(row({ attachmentsUndecryptable: "3" }), "u")).not.toHaveProperty("source_metrics");
    expect(buildSyncOutcomeRow(row({ attachmentsUndecryptable: -1 }), "u")).not.toHaveProperty("source_metrics");
  });

  it("a source's own metrics (Google Messages) are never replaced", () => {
    const r = buildSyncOutcomeRow(row({ backupPassword: "stored" }, { sourceMetrics: { rcs: 1 } }), "u");
    expect(r.source_metrics).toEqual({ rcs: 1 });
  });
});
