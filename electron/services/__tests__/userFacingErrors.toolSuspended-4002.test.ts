/**
 * BACKLOG-4002 (N6) — the exact words: the live suspended notice (a), the watchdog stop
 * (b1 notice showing / b2 not), and the corrected IPHONE_TOOL_TIMEOUT message (c).
 */
import {
  formatToolSuspendedNotice,
  formatBackupWatchdogError,
  formatIphoneToolTimeoutError,
  formatToolBlockedError,
  SUPPORT_CLOSING_LINE,
} from "../diagnostics/userFacingErrors";
import { BACKUP_WATCHDOG_NO_PROGRESS_TIMEOUT_MS, IPHONE_QUERY_TIMEOUT_MS } from "../iphoneToolLimits";
import { BackupService } from "../backupService";

const FOLDER = "C:\\Users\\Example\\AppData\\Local\\Programs\\Keepr";

describe("(a) the live notice", () => {
  it("with the folder", () => {
    expect(formatToolSuspendedNotice(FOLDER)).toEqual({
      title: "Your antivirus may have paused the backup",
      description:
        "Something on this computer, usually antivirus software, has paused the tool Keepr uses to back up your iPhone. The backup cannot continue while it is paused.",
      actionSuggestion: [
        "1. Open your antivirus program.",
        "2. If any Keepr files are in its Quarantine list, restore them.",
        `3. Add an exception for the Keepr folder: ${FOLDER}`,
        "4. If the backup does not continue within a minute, select Cancel, then Try Again.",
        SUPPORT_CLOSING_LINE,
      ].join("\n"),
      code: "IPHONE_TOOL_SUSPENDED",
    });
  });

  it("without the folder", () => {
    expect(formatToolSuspendedNotice(null).actionSuggestion.split("\n")[2]).toBe(
      "3. Add an exception for the Keepr folder.",
    );
  });
});

describe("(b) BACKUP_TIMEOUT", () => {
  it("b1, the notice was showing when the watchdog fired", () => {
    expect(formatBackupWatchdogError({ toolSuspendedAtTimeout: true, keeprFolder: FOLDER, platform: "win32" })).toEqual({
      title: "Your antivirus may have paused the backup",
      description:
        "Something on this computer, usually antivirus software, paused the tool Keepr uses to back up your iPhone. The backup made no progress for 30 minutes, so Keepr stopped it.",
      actionSuggestion: [
        "1. Open your antivirus program.",
        "2. If any Keepr files are in its Quarantine list, restore them.",
        `3. Add an exception for the Keepr folder: ${FOLDER}`,
        "4. Select Try Again.",
        SUPPORT_CLOSING_LINE,
      ].join("\n"),
      code: "BACKUP_TIMEOUT",
    });
  });

  it("b2 on Windows: the unlock step, the antivirus-alert step, Try Again", () => {
    expect(formatBackupWatchdogError({ toolSuspendedAtTimeout: false, keeprFolder: FOLDER, platform: "win32" })).toEqual({
      title: "The backup stopped making progress",
      description: "The backup made no progress for 30 minutes, so Keepr stopped it.",
      actionSuggestion: [
        "1. Unlock your iPhone and keep it unlocked and connected until the sync finishes.",
        `2. If your antivirus is showing an alert about Keepr, open your antivirus program and add an exception for the Keepr folder: ${FOLDER}`,
        "3. Select Try Again.",
        SUPPORT_CLOSING_LINE,
      ].join("\n"),
      code: "BACKUP_TIMEOUT",
    });
  });

  it("b2 on macOS: no antivirus step", () => {
    expect(
      formatBackupWatchdogError({ toolSuspendedAtTimeout: false, keeprFolder: null, platform: "darwin" }).actionSuggestion,
    ).toBe(
      [
        "1. Unlock your iPhone and keep it unlocked and connected until the sync finishes.",
        "2. Select Try Again.",
        SUPPORT_CLOSING_LINE,
      ].join("\n"),
    );
  });

  it("the 30 is the watchdog's own limit (SR R6)", () => {
    expect(BACKUP_WATCHDOG_NO_PROGRESS_TIMEOUT_MS).toBe(30 * 60_000);
    expect(BackupService.WATCHDOG_NO_PROGRESS_TIMEOUT_MS).toBe(BACKUP_WATCHDOG_NO_PROGRESS_TIMEOUT_MS);
  });
});

describe("(c) IPHONE_TOOL_TIMEOUT, corrected", () => {
  it("with the folder", () => {
    expect(formatIphoneToolTimeoutError(FOLDER)).toEqual({
      title: "This is taking longer than expected",
      description:
        "Keepr's iPhone check did not finish within 90 seconds, so Keepr stopped it. Sometimes security software pauses Keepr's iPhone tools while it checks them.",
      actionSuggestion: [
        "1. Make sure your iPhone is unlocked and still connected.",
        `2. If your antivirus is showing an alert about Keepr, open your antivirus program and add an exception for the Keepr folder: ${FOLDER}`,
        "3. Wait a moment, then select Try Again.",
        SUPPORT_CLOSING_LINE,
      ].join("\n"),
      code: "IPHONE_TOOL_TIMEOUT",
    });
    expect(IPHONE_QUERY_TIMEOUT_MS).toBe(90_000);
  });
});

describe("the messages stay distinct and never say the risky words", () => {
  const all = [
    formatToolSuspendedNotice(FOLDER),
    formatToolSuspendedNotice(null),
    formatBackupWatchdogError({ toolSuspendedAtTimeout: true, keeprFolder: FOLDER, platform: "win32" }),
    formatBackupWatchdogError({ toolSuspendedAtTimeout: false, keeprFolder: FOLDER, platform: "win32" }),
    formatBackupWatchdogError({ toolSuspendedAtTimeout: false, keeprFolder: null, platform: "darwin" }),
    formatIphoneToolTimeoutError(FOLDER),
    formatIphoneToolTimeoutError(null),
  ];

  it("no 'allow it', no 'waiting for your iPhone'; every one ends with the support line", () => {
    for (const m of all) {
      const text = `${m.title}\n${m.description}\n${m.actionSuggestion}`;
      expect(text).not.toMatch(/allow it/i);
      expect(text).not.toMatch(/waiting for your iPhone/i);
      expect(m.actionSuggestion.split("\n").pop()).toBe(SUPPORT_CLOSING_LINE);
    }
  });

  it("BACKUP_TIMEOUT never reuses the IPHONE_TOOL_TIMEOUT title or description", () => {
    const timeout = formatIphoneToolTimeoutError(FOLDER);
    for (const suspendedAtTimeout of [true, false]) {
      const b = formatBackupWatchdogError({ toolSuspendedAtTimeout: suspendedAtTimeout, keeprFolder: FOLDER, platform: "win32" });
      expect(b.title).not.toBe(timeout.title);
      expect(b.description).not.toBe(timeout.description);
      expect(b.code).not.toBe(timeout.code);
    }
  });

  it("the notice is not the tool-blocked message", () => {
    const blocked = formatToolBlockedError(FOLDER);
    expect(formatToolSuspendedNotice(FOLDER).title).not.toBe(blocked.title);
    expect(formatToolSuspendedNotice(FOLDER).code).not.toBe(blocked.code);
  });
});
