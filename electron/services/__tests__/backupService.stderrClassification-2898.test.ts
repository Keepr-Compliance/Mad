/**
 * BACKLOG-2898 — libimobiledevice stderr: what is a fault and what is chatter.
 *
 * FIXTURES ARE TRANSCRIBED, NOT INVENTED. Every chunk below is copied verbatim
 * from the founder's real PC log of a backup that COMPLETED SUCCESSFULLY
 * (2026-08-26, 703,761 B / 4,023 lines). They contain no user data: the only
 * paths are libimobiledevice's own build paths, baked into its binary at
 * compile time on its CI machine.
 *
 * Measured over all 336 `stderr (error pattern)` records in that log: exactly
 * one trigger word ever fired — "locked" — and in every case it came from the
 * pthread mutex trace `notification_proxy.c:52 np_lock(): Locked`. Not one
 * record contained a non-mutex trigger. So these controls pin BOTH halves:
 * the chatter goes quiet, and every genuine trigger still warns.
 */

import log from "electron-log";
import { BackupService } from "../backupService";

jest.mock("@sentry/electron/main");

/** Transcribed verbatim — founder's log, 16:06:22 / 16:06:23 / 16:06:26. */
const HEALTHY_BACKUP_STDERR = [
  `16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\idevice.c:652 idevice_connection_receive_timeout(): SSL_read 32768, received 32768
16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\idevice.c:652 idevice_connection_receive_timeout(): SSL_read 32768, received 32768
16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\notification_proxy.c:52 np_lock(): Locked`,

  `16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\idevice.c:652 idevice_connection_receive_timeout(): SSL_read 4, received 0
16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\property_list_service.c:196 internal_plist_receive_timeout(): initial read failed!
16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\notification_proxy.c:271 np_get_notification(): NotificationProxy: no notification received!
16:06:23 D:\\a\\1\\s\\libimobiledevice\\src\\notification_proxy.c:63 np_unlock(): Unlocked`,

  `16:06:26 D:\\a\\1\\s\\libimobiledevice\\src\\idevice.c:652 idevice_connection_receive_timeout(): SSL_read 32768, received 32768
16:06:26 D:\\a\\1\\s\\libimobiledevice\\src\\property_list_service.c:196 internal_plist_receive_timeout(): initial read failed!
16:06:26 D:\\a\\1\\s\\libimobiledevice\\src\\notification_proxy.c:271 np_get_notification(): NotificationProxy: no notification received!`,
];

/** Real faults this channel must keep carrying. */
const GENUINE_FAULTS = [
  "ERROR: Device is locked, please unlock it and enter your passcode",
  "ERROR: Could not start service com.apple.mobilebackup2. Trust the computer first.",
  "ERROR: Backup password is incorrect",
  "ERROR: Not enough disk space on the target volume",
  "16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\userpref.c:412 userpref_read_pair_record(): could not read pair record",
];

/**
 * Drive the PRIVATE per-line classifier the stderr handler calls. Reaching it
 * directly keeps the control on the classification decision itself rather than
 * on child_process plumbing.
 */
function classify(service: BackupService, chunk: string): void {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    (service as unknown as { classifyStderrLine(l: string): void }).classifyStderrLine(line);
  }
}

function warnedLines(): string[] {
  return (log.warn as jest.Mock).mock.calls
    .filter((c) => String(c[0]).includes("stderr (error pattern)"))
    .map((c) => String(c[1] ?? ""));
}

describe("BACKLOG-2898: libimobiledevice stderr classification", () => {
  let service: BackupService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BackupService();
  });

  it("logs NOTHING at warn for a healthy backup's mutex chatter", () => {
    for (const chunk of HEALTHY_BACKUP_STDERR) classify(service, chunk);
    expect(warnedLines()).toEqual([]);
  });

  it("still warns on every genuine fault", () => {
    for (const fault of GENUINE_FAULTS) classify(service, fault);
    expect(warnedLines()).toHaveLength(GENUINE_FAULTS.length);
  });

  it("warns on a device-locked message even though 'Locked' is also a mutex word", () => {
    classify(service, "ERROR: Device is locked, please unlock it and enter your passcode");
    expect(warnedLines()[0]).toContain("Device is locked");
  });

  it("still warns when a real signal shares a line with a mutex trace", () => {
    classify(
      service,
      "16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\notification_proxy.c:52 np_lock(): Locked — no device found",
    );
    expect(warnedLines()).toHaveLength(1);
  });

  it("logs the matching LINE, not a 500-char window of unrelated debug output", () => {
    classify(
      service,
      `16:06:22 D:\\a\\1\\s\\libimobiledevice\\src\\idevice.c:652 idevice_connection_receive_timeout(): SSL_read 32768, received 32768
ERROR: Backup password is incorrect`,
    );
    const warned = warnedLines();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toBe("ERROR: Backup password is incorrect");
    expect(warned[0]).not.toContain("idevice_connection_receive_timeout");
  });
});
