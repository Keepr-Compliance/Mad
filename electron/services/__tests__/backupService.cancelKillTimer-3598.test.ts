/**
 * BACKLOG-3598 — `cancelBackup`'s 5-second force-kill hits only the process it was
 * armed for.
 *
 * After an unplug, the orchestrator stops the backup with `cancelBackup`. The process
 * closes (clearing `currentProcess`), cleanup runs, and the user can re-plug and start
 * a new backup inside 5 s. The force-kill timer used to read `currentProcess` when it
 * fired, so it killed THAT new backup.
 *
 * `currentProcess` is set directly: spawning a real idevicebackup2 is not possible here,
 * and the timer only ever touches `kill` and the `currentProcess` field.
 */

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp/keepr-3598-cancel-timer") },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));
jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
  canUseLibimobiledevice: jest.fn(() => true),
}));
jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({})),
  backupDecryptionService: { isBackupEncrypted: jest.fn().mockResolvedValue(false), decryptBackup: jest.fn() },
}));
jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({ all: jest.fn(), get: jest.fn(), run: jest.fn() }),
    close: jest.fn(),
  })),
);

import { BackupService } from "../backupService";

type FakeProcess = { kill: jest.Mock };
const fakeProcess = (): FakeProcess => ({ kill: jest.fn() });
const setCurrent = (svc: BackupService, p: FakeProcess | null) => {
  (svc as unknown as { currentProcess: FakeProcess | null }).currentProcess = p;
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("BACKLOG-3598: cancelBackup force-kill timer", () => {
  it("a new backup started inside 5 s of the cancel is NOT killed", () => {
    const svc = new BackupService();
    const stopped = fakeProcess();
    setCurrent(svc, stopped);

    svc.cancelBackup();
    expect(stopped.kill).toHaveBeenCalledWith("SIGTERM");

    // The stopped process closed; the user re-plugged and a new backup started.
    const next = fakeProcess();
    setCurrent(svc, next);
    jest.advanceTimersByTime(5000);

    expect(next.kill).not.toHaveBeenCalled();
    expect(stopped.kill).toHaveBeenCalledTimes(1);
  });

  it("a process that ignored SIGTERM is still force-killed after 5 s", () => {
    const svc = new BackupService();
    const stuck = fakeProcess();
    setCurrent(svc, stuck);

    svc.cancelBackup();
    jest.advanceTimersByTime(5000);

    expect(stuck.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(stuck.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });
});
