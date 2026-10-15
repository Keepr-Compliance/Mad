/**
 * BACKLOG-3892 E: the backup-problem classes, the Sentry reason set, and what reaches
 * sync_outcomes.source_metrics.
 */
jest.mock("@sentry/electron/main", () => ({ captureMessage: jest.fn() }));

import * as Sentry from "@sentry/electron/main";
import {
  BACKUP_DAMAGED_QUARANTINED_MESSAGE,
  BACKUP_DAMAGED_RETRY_MESSAGE,
  BACKUP_KEY_MISSING_QUARANTINED_MESSAGE,
  BACKUP_KEY_MISSING_RETRY_MESSAGE,
  backupProblemForRefusal,
  unreadableKind,
} from "../backupProblem";
import { reportBackupProblem } from "../backupProblemReport";
import { backupEncryptionMetrics } from "../../syncOutcomeSupabase";

describe("unreadableKind", () => {
  it.each([
    [["INTEGRITY"], "damaged"],
    [["KEY_MISSING"], "key-missing"],
    [["INTEGRITY", "KEY_MISSING"], "damaged"],
    [["KEY_MISSING", "INTEGRITY"], "damaged"],
  ] as const)("%j -> %s", (codes, kind) => {
    expect(unreadableKind(codes)).toBe(kind);
  });
});

describe("backupProblemForRefusal", () => {
  it.each([
    ["key-unavailable", undefined, "key-unavailable"],
    ["disk-space", undefined, "disk-space"],
    ["unreadable", undefined, "unreadable"],
    ["unreadable", "damaged", "damaged"],
    ["unreadable", "key-missing", "key-missing"],
    ["busy", undefined, null],
    ["cancelled", undefined, null],
    ["something-new", undefined, null],
  ] as const)("%s (%s) -> %s", (reason, problem, expected) => {
    expect(backupProblemForRefusal(reason, problem)).toBe(expected);
  });
});

describe("the lines (founder sentence + the next step already shipped)", () => {
  it("are exactly these", () => {
    expect(BACKUP_DAMAGED_QUARANTINED_MESSAGE).toBe(
      "Your saved iPhone backup is damaged. Keepr will make a fresh full backup, which takes longer.",
    );
    expect(BACKUP_DAMAGED_RETRY_MESSAGE).toBe(
      "Your saved iPhone backup is damaged. Select Try Again: Keepr will make a fresh full backup, which takes longer.",
    );
  });
});

describe("the key-missing lines (founder sentence 2026-10-12 + the same next step)", () => {
  it("are exactly these", () => {
    expect(BACKUP_KEY_MISSING_QUARANTINED_MESSAGE).toBe(
      "Keepr cannot decrypt your saved iPhone backup on this computer. Keepr will make a fresh full backup, which takes longer.",
    );
    expect(BACKUP_KEY_MISSING_RETRY_MESSAGE).toBe(
      "Keepr cannot decrypt your saved iPhone backup on this computer. Select Try Again: Keepr will make a fresh full backup, which takes longer.",
    );
  });
});

describe("reportBackupProblem", () => {
  it("sends tags only — no path, udid or text — and never throws", () => {
    const capture = Sentry.captureMessage as jest.Mock;
    capture.mockClear();
    reportBackupProblem("damaged");
    expect(capture.mock.calls).toEqual([
      [
        "iPhone backup problem",
        { level: "warning", tags: { component: "iphone_backup", reason: "damaged" }, fingerprint: ["iphone-backup-problem", "damaged"] },
      ],
    ]);
    capture.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    expect(() => reportBackupProblem("unreadable")).not.toThrow();
  });
});

describe("source_metrics carries the kept-backup facts, allow-listed values only", () => {
  it("quarantined + reason", () => {
    expect(backupEncryptionMetrics({ keptBackup: "quarantined", keptBackupReason: "key-missing", keptBackupReasonCode: "KEY_MISSING" })).toEqual({
      keptBackup: "quarantined",
      keptBackupReason: "key-missing",
    });
  });
  it("an unknown value is not carried", () => {
    expect(backupEncryptionMetrics({ keptBackup: "/Users/someone/Backups", keptBackupReason: "lost" })).toBeUndefined();
  });
});
