/**
 * BACKLOG-2931 — the connect screen's "First sync may take up to two hours…" sentence.
 *
 * It keyed on `lastSyncTime`, which collapses to null for "never synced", "no signed-in
 * user", "Supabase error", "the fetch threw" (syncHandlers.ts sync:get-iphone-last-sync-time)
 * and "still loading" (useIPhoneSync's initial state). Every one of those showed the
 * two-hour sentence. A user who synced on another computer had a row, saw "Incremental",
 * and then waited hours for a full transfer.
 *
 * The sentence now follows the SAME determination as the progress-screen banner
 * (BACKLOG-2907 / 2938): `PriorBackupState` from `toPriorBackupState` over
 * `checkBackupStatus`, read before the sync through `backup:check-status`.
 *   "none"    -> the two-hour sentence
 *   "exists"  -> the incremental sentence
 *   "unknown" -> neither (loading, the check failed, the reply is missing the field)
 * `lastSyncTime` keeps the "Last synced" row and the button label.
 *
 * FIXTURES — transcribed, not invented:
 * - BackupStatusReport shapes: `backupService.checkBackupStatus`'s three return statements.
 *   The unusable directory is the founder's measured state quoted in
 *   deviceSyncOrchestrator.ts (BACKLOG-2938): Info.plist only (6.3 MB), no Manifest.db,
 *   `SnapshotState: uploading` -> `isComplete: false`, `isInterrupted: true`.
 * - check-status replies: the `backup:check-status` handler's return statements
 *   (backupHandlers.ts), produced here by running the real handler over those reports.
 * - Harness: the REAL useIPhoneSync drives the REAL IPhoneSyncFlow, as in
 *   IPhoneSyncFlow.cancelRestart-4116.test.tsx (only the context lookup is redirected).
 */
import React, { StrictMode } from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ipcMain } from "electron";
import * as orchestratorModule from "../../../../electron/services/deviceSyncOrchestrator";
import { backupService } from "../../../../electron/services/backupService";
import { registerBackupHandlers } from "../../../../electron/handlers/backupHandlers";
import { useIPhoneSync, syncStateRef } from "../../../hooks/useIPhoneSync";
import { syncOrchestrator } from "../../../services/SyncOrchestratorService";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import { ConnectionStatus } from "../ConnectionStatus";
import type { UseIPhoneSyncReturn, PriorBackupState } from "../../../types/iphone";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: true, isMacOS: false, isLinux: false, isWindowsArm64: false, platform: "win32" }),
}));
jest.mock("../../../utils/platform", () => ({
  ...jest.requireActual("../../../utils/platform"),
  isWindowsArm64: () => false,
}));

let currentHook: UseIPhoneSyncReturn | null = null;
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => currentHook,
}));

const TWO_HOURS = /may take up to two hours/;
const INCREMENTAL = /will only transfer new data since your last sync/;
const SYNC_LABEL = "Sync Messages & Contacts";
const SYNC_NEW_LABEL = "Sync New Data";

// `toPriorBackupState` is read off the module object so this file still loads against
// code that predates it (the red-before run records each test's own failure).
const toPriorBackupState = (report: unknown): PriorBackupState =>
  (orchestratorModule as unknown as { toPriorBackupState: (r: unknown) => PriorBackupState })
    .toPriorBackupState(report);

// ---- BackupStatusReport shapes (backupService.checkBackupStatus) ----
const LAST_MODIFIED = new Date("2026-10-30T18:00:00Z");
const REPORT_COMPLETE = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  lastModified: LAST_MODIFIED,
  size: { measured: true as const, bytes: 58_800_000_000 },
};
/** BACKLOG-2911: interrupted but complete is usable. */
const REPORT_COMPLETE_INTERRUPTED = { ...REPORT_COMPLETE, isInterrupted: true, snapshotState: "unfinished" as const };
/** BACKLOG-2938: the founder's measured directory — Info.plist only, no manifest. */
const REPORT_UNUSABLE = {
  state: "present" as const,
  isComplete: false,
  isInterrupted: true,
  snapshotState: "unfinished" as const,
  lastModified: LAST_MODIFIED,
  size: { measured: true as const, bytes: 6_300_000 },
};
const REPORT_ABSENT = { state: "absent" as const };
const REPORT_UNKNOWN = { state: "unknown" as const, reason: "EACCES: permission denied" };

// ---- the real backup:check-status handler ----
type CheckStatusReply = Record<string, unknown>;
let checkStatusHandler: ((event: unknown, udid: string) => Promise<CheckStatusReply>) | null = null;
function realCheckStatusHandler() {
  if (!checkStatusHandler) {
    registerBackupHandlers({} as never);
    const call = (ipcMain.handle as jest.Mock).mock.calls.find((c) => c[0] === "backup:check-status");
    checkStatusHandler = call![1];
  }
  return checkStatusHandler!;
}
async function replyFor(report: unknown): Promise<CheckStatusReply> {
  const spy = jest.spyOn(backupService, "checkBackupStatus").mockResolvedValue(report as never);
  try {
    return await realCheckStatusHandler()({}, DEVICE.udid);
  } finally {
    spy.mockRestore();
  }
}

const DEVICE = {
  udid: "00008110-000A2931000B2931",
  name: "Test iPhone",
  productType: "iPhone15,2",
  productVersion: "18.0",
  serialNumber: "SERIAL2931",
  isConnected: true,
};
const DEVICE_B = { ...DEVICE, udid: "00008110-000B2931000C2931", name: "Other iPhone" };

// ---------------------------------------------------------------------------
// 1. The component, driven by props
// ---------------------------------------------------------------------------
function renderConnected(props: { priorBackup?: PriorBackupState; lastSyncTime?: Date | null }) {
  const extra = props as Record<string, unknown>;
  return render(
    <StrictMode>
      <ConnectionStatus isConnected device={DEVICE} onSyncClick={jest.fn()} {...extra} />
    </StrictMode>,
  );
}

describe("BACKLOG-2931 ConnectionStatus: the sync-time sentence follows prior-backup usability", () => {
  it("C1: 'none' shows the two-hour sentence even when a lastSyncTime exists (synced on another computer)", () => {
    renderConnected({ priorBackup: "none", lastSyncTime: new Date("2026-10-01T09:00:00Z") });
    expect(screen.getByText(TWO_HOURS)).toBeInTheDocument();
    expect(screen.queryByText(INCREMENTAL)).not.toBeInTheDocument();
  });

  it("C1: 'none' with no lastSyncTime shows the two-hour sentence", () => {
    renderConnected({ priorBackup: "none", lastSyncTime: null });
    expect(screen.getByText(TWO_HOURS)).toBeInTheDocument();
    expect(screen.queryByText(INCREMENTAL)).not.toBeInTheDocument();
  });

  it("C2: 'exists' shows the incremental sentence even when lastSyncTime is null", () => {
    renderConnected({ priorBackup: "exists", lastSyncTime: null });
    expect(screen.getByText(INCREMENTAL)).toBeInTheDocument();
    expect(screen.queryByText(TWO_HOURS)).not.toBeInTheDocument();
  });

  it.each([
    ["'unknown', lastSyncTime null", { priorBackup: "unknown" as const, lastSyncTime: null }],
    ["'unknown', lastSyncTime set", { priorBackup: "unknown" as const, lastSyncTime: new Date("2026-10-01T09:00:00Z") }],
    ["prop omitted", { lastSyncTime: null }],
  ])("C3: %s shows neither sentence", (_label, props) => {
    renderConnected(props);
    expect(screen.queryByText(TWO_HOURS)).not.toBeInTheDocument();
    expect(screen.queryByText(INCREMENTAL)).not.toBeInTheDocument();
  });

  it("C5: 'Last synced' and the button label still follow lastSyncTime, not the backup state", () => {
    const { unmount } = renderConnected({ priorBackup: "none", lastSyncTime: new Date("2026-10-01T09:00:00Z") });
    expect(screen.getByText(/Last synced:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SYNC_NEW_LABEL })).toBeInTheDocument();
    unmount();

    renderConnected({ priorBackup: "exists", lastSyncTime: null });
    expect(screen.queryByText(/Last synced:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: SYNC_LABEL })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. The producer: one mapping, shared by the orchestrator and backup:check-status
// ---------------------------------------------------------------------------
describe("BACKLOG-2931 producer: toPriorBackupState and backup:check-status", () => {
  it.each([
    ["present + complete", REPORT_COMPLETE, "exists"],
    ["present + complete + interrupted (2911: usable)", REPORT_COMPLETE_INTERRUPTED, "exists"],
    ["present + NOT complete (2938: Info.plist only)", REPORT_UNUSABLE, "none"],
    ["absent (proven ENOENT)", REPORT_ABSENT, "none"],
    ["unknown (the check failed)", REPORT_UNKNOWN, "unknown"],
  ])("C4: %s -> %s", (_label, report, expected) => {
    expect(toPriorBackupState(report)).toBe(expected);
  });

  it.each([
    ["present + complete", REPORT_COMPLETE, "exists"],
    ["present + NOT complete", REPORT_UNUSABLE, "none"],
    ["absent", REPORT_ABSENT, "none"],
    ["unknown", REPORT_UNKNOWN, "unknown"],
  ])("C4: the handler replies priorBackup for %s -> %s", async (_label, report, expected) => {
    const reply = await replyFor(report);
    expect(reply.success).toBe(true);
    expect(reply.priorBackup).toBe(expected);
  });

  it("C4: a thrown check replies without claiming a backup state", async () => {
    const spy = jest.spyOn(backupService, "checkBackupStatus").mockRejectedValue(new Error("boom"));
    try {
      const reply = await realCheckStatusHandler()({}, DEVICE.udid);
      expect(reply.success).toBe(false);
      expect(reply.priorBackup === undefined || reply.priorBackup === "unknown").toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("the handler reads the recorded size, so a connect does not walk the whole backup (BACKLOG-3816)", async () => {
    const spy = jest.spyOn(backupService, "checkBackupStatus").mockResolvedValue(REPORT_COMPLETE as never);
    try {
      await realCheckStatusHandler()({}, DEVICE.udid);
      expect(spy).toHaveBeenCalledWith(DEVICE.udid, expect.objectContaining({ useRecordedSize: true }));
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The real hook driving the real flow
// ---------------------------------------------------------------------------
type Cb = (arg?: unknown) => void;
const cbs: Record<string, Cb> = {};
const on = (name: string) => jest.fn((cb: Cb) => { cbs[name] = cb; return jest.fn(); });

let syncApi: Record<string, jest.Mock>;
let checkStatus: jest.Mock;
let startReplies: Array<(reply: unknown) => void> = [];

function installApi(opts: { lastSyncTime?: string | null; withBackupApi?: boolean } = {}) {
  syncApi = {
    startDetection: jest.fn(),
    stopDetection: jest.fn(),
    start: jest.fn(() => new Promise((resolve) => { startReplies.push(resolve); })),
    cancel: jest.fn().mockResolvedValue({ success: true }),
    getUnifiedStatus: jest.fn().mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
    getIPhoneLastSyncTime: jest.fn().mockResolvedValue({ lastSyncTime: opts.lastSyncTime ?? null }),
    onDeviceConnected: on("connected"),
    onDeviceDisconnected: on("disconnected"),
    onProgress: on("progress"),
    onPasswordRequired: on("password"),
    onError: on("error"),
    onComplete: on("complete"),
    onWaitingForPasscode: on("waiting"),
    onPasscodeEntered: on("passcode"),
    onStorageComplete: on("storageComplete"),
    onStorageError: on("storageError"),
  };
  checkStatus = jest.fn(() => new Promise(() => { /* pending unless a test overrides */ }));
  const api: Record<string, unknown> = { sync: syncApi };
  if (opts.withBackupApi !== false) api.backup = { checkStatus };
  (window as unknown as { api: unknown }).api = api;
}

function Harness() {
  currentHook = useIPhoneSync(true);
  return <IPhoneSyncFlow />;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function connect(device: typeof DEVICE = DEVICE) {
  await act(async () => {
    cbs.connected(device);
  });
  await flush();
}

function expectNeitherSentence() {
  expect(screen.queryByText(TWO_HOURS)).not.toBeInTheDocument();
  expect(screen.queryByText(INCREMENTAL)).not.toBeInTheDocument();
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
  jest.setSystemTime(new Date("2026-11-05T10:00:00Z"));
  syncStateRef.isActive = false;
  syncStateRef.deferredLogout = false;
  syncOrchestrator.reset();
  startReplies = [];
  currentHook = null;
  for (const k of Object.keys(cbs)) delete cbs[k];
  installApi();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-2931 connect screen: real hook + real flow", () => {
  it("C3: while the backup check is still pending, neither sentence shows", async () => {
    render(<Harness />);
    await connect();
    expect(screen.getByRole("button", { name: SYNC_LABEL })).toBeInTheDocument();
    expectNeitherSentence();
    expect(currentHook!.priorBackup).toBe("unknown");
  });

  it("C3: the backup check rejecting shows neither sentence", async () => {
    checkStatus.mockRejectedValue(new Error("No handler registered for 'backup:check-status'"));
    render(<Harness />);
    await connect();
    expectNeitherSentence();
    expect(currentHook!.priorBackup).toBe("unknown");
  });

  it("C3: a check-status reply of success:false shows neither sentence", async () => {
    checkStatus.mockResolvedValue({ success: false, error: "Device UDID is required" });
    render(<Harness />);
    await connect();
    expectNeitherSentence();
  });

  it("C3: a reply without priorBackup shows neither sentence", async () => {
    checkStatus.mockResolvedValue({ success: true, state: "present", isComplete: true, lastSyncTime: null });
    render(<Harness />);
    await connect();
    expectNeitherSentence();
  });

  it("C3: no backup API at all shows neither sentence", async () => {
    installApi({ withBackupApi: false });
    render(<Harness />);
    await connect();
    expectNeitherSentence();
  });

  it("C4: a Supabase lastSyncTime plus an unusable backup on this computer shows the two-hour sentence", async () => {
    installApi({ lastSyncTime: "2026-10-01T09:00:00.000Z" });
    const reply = await replyFor(REPORT_UNUSABLE);
    checkStatus.mockResolvedValue(reply);
    render(<Harness />);
    await connect();
    expect(screen.getByText(TWO_HOURS)).toBeInTheDocument();
    expect(screen.queryByText(INCREMENTAL)).not.toBeInTheDocument();
    // C5: the row and the label still follow lastSyncTime.
    expect(screen.getByText(/Last synced:/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SYNC_NEW_LABEL })).toBeInTheDocument();
  });

  it("C2: a usable backup with no Supabase row shows the incremental sentence", async () => {
    const reply = await replyFor(REPORT_COMPLETE);
    checkStatus.mockResolvedValue(reply);
    render(<Harness />);
    await connect();
    expect(screen.getByText(INCREMENTAL)).toBeInTheDocument();
    expect(screen.queryByText(TWO_HOURS)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: SYNC_LABEL })).toBeInTheDocument();
  });

  it("C1: a proven-absent backup shows the two-hour sentence", async () => {
    const reply = await replyFor(REPORT_ABSENT);
    checkStatus.mockResolvedValue(reply);
    render(<Harness />);
    await connect();
    expect(screen.getByText(TWO_HOURS)).toBeInTheDocument();
  });

  it("C6: the reader is called once per connect, for the connected device", async () => {
    checkStatus.mockResolvedValue(await replyFor(REPORT_COMPLETE));
    render(<Harness />);
    await connect();
    await flush();
    expect(checkStatus).toHaveBeenCalledTimes(1);
    expect(checkStatus).toHaveBeenCalledWith(DEVICE.udid);
  });

  it("C6: a completed sync re-reads the backup state", async () => {
    checkStatus.mockResolvedValueOnce(await replyFor(REPORT_ABSENT));
    render(<Harness />);
    await connect();
    expect(currentHook!.priorBackup).toBe("none");

    checkStatus.mockResolvedValueOnce(await replyFor(REPORT_COMPLETE));
    fireEvent.click(screen.getByRole("button", { name: SYNC_LABEL }));
    await flush();
    await act(async () => {
      cbs.storageComplete({ messagesStored: 10, contactsStored: 2, duration: 1000 });
    });
    await flush();

    expect(checkStatus).toHaveBeenCalledTimes(2);
    expect(checkStatus).toHaveBeenLastCalledWith(DEVICE.udid);
    expect(currentHook!.priorBackup).toBe("exists");
  });

  it("a disconnect forgets the answer for the device that left", async () => {
    checkStatus.mockResolvedValueOnce(await replyFor(REPORT_COMPLETE));
    render(<Harness />);
    await connect(DEVICE);
    expect(currentHook!.priorBackup).toBe("exists");

    await act(async () => { cbs.disconnected(); });
    expect(currentHook!.priorBackup).toBe("unknown");
  });

  it("a late answer for the old device is not applied to the new one", async () => {
    let resolveA: (v: unknown) => void = () => {};
    checkStatus.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    render(<Harness />);
    await connect(DEVICE);
    await act(async () => { cbs.disconnected(); });

    // B's own check stays pending.
    await connect(DEVICE_B);
    const replyA = await replyFor(REPORT_COMPLETE);
    await act(async () => { resolveA(replyA); });
    await flush();
    expect(currentHook!.priorBackup).toBe("unknown");
    expectNeitherSentence();
  });
});
