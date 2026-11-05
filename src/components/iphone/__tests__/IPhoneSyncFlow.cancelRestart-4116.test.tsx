/**
 * BACKLOG-4116 — Start pressed straight after Cancel showed "Sync Failed / Sync already in progress".
 *
 * Cancel clears main's "is running" flags at once while the cancelled backup still stops
 * (~10 s). Main refuses a start in that window (deviceSyncOrchestrator.ts, the backupInFlight
 * guard). The renderer already receives the end of that window: the cancelled run's own
 * sync:start request returns "Sync cancelled by user". Until it does, Sync stays disabled and
 * reads "Stopping the previous sync…".
 *
 * The REAL useIPhoneSync hook drives the REAL IPhoneSyncFlow (same harness as
 * IPhoneSyncFlow.failureUx-3816.test.tsx; only the context lookup is redirected).
 *
 * FIXTURES — transcribed, not invented:
 * - REFUSAL: the backupInFlight guard's return (deviceSyncOrchestrator.ts, `error: "Sync already
 *   in progress", duration: 0`, no errorCode) as sync:start's toSyncReply passes it on.
 * - CANCELLED: `errorResult("Sync cancelled by user")`, the cancelled frame's exit.
 */
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { useIPhoneSync, syncStateRef } from "../../../hooks/useIPhoneSync";
import { syncOrchestrator } from "../../../services/SyncOrchestratorService";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";

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

const STOPPING_LABEL = "Stopping the previous sync…";
const SYNC_LABEL = "Sync Messages & Contacts";

const REFUSAL = {
  success: false,
  messageCount: 0,
  contactCount: 0,
  conversationCount: 0,
  error: "Sync already in progress",
  duration: 0,
};
const CANCELLED = {
  success: false,
  messageCount: 0,
  contactCount: 0,
  conversationCount: 0,
  error: "Sync cancelled by user",
  duration: 0,
};

const DEVICE = {
  udid: "00008110-000A4116000B4116",
  name: "Test iPhone",
  productType: "iPhone15,2",
  productVersion: "18.0",
  serialNumber: "SERIAL4116",
  isConnected: true,
};

type Cb = (arg?: unknown) => void;
const cbs: Record<string, Cb> = {};
const on = (name: string) => jest.fn((cb: Cb) => { cbs[name] = cb; return jest.fn(); });

let syncApi: Record<string, jest.Mock>;
/** One resolver per sync:start call, in call order. */
let startReplies: Array<(reply: unknown) => void> = [];

function installApi() {
  syncApi = {
    startDetection: jest.fn(),
    stopDetection: jest.fn(),
    start: jest.fn(() => new Promise((resolve) => { startReplies.push(resolve); })),
    cancel: jest.fn().mockResolvedValue({ success: true }),
    getUnifiedStatus: jest.fn().mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
    getIPhoneLastSyncTime: jest.fn().mockResolvedValue({ lastSyncTime: null }),
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
  (window as unknown as { api: unknown }).api = { sync: syncApi };
}

function Harness() {
  currentHook = useIPhoneSync(true);
  return <IPhoneSyncFlow />;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function connect() {
  await act(async () => {
    cbs.connected(DEVICE);
  });
  await flush();
}

/** Click Sync and reach the backup phase; the start request stays pending. */
async function startABackup() {
  fireEvent.click(screen.getByRole("button", { name: SYNC_LABEL }));
  await flush();
  await act(async () => {
    cbs.progress({ phase: "backup", overallProgress: 5, message: "Backing up..." });
  });
}

async function pressCancel() {
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await flush();
}

async function reply(index: number, value: unknown) {
  await act(async () => {
    startReplies[index](value);
  });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
  jest.setSystemTime(new Date("2026-11-04T10:00:00Z"));
  syncStateRef.isActive = false;
  syncStateRef.deferredLogout = false;
  syncOrchestrator.reset();
  startReplies = [];
  for (const k of Object.keys(cbs)) delete cbs[k];
  installApi();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-4116: Start after Cancel waits for the cancelled sync to stop", () => {
  it("C1: Sync reads 'Stopping the previous sync…' and is disabled until the cancelled request returns, then starts normally", async () => {
    render(<Harness />);
    await connect();
    await startABackup();
    expect(syncApi.start).toHaveBeenCalledTimes(1);

    await pressCancel();

    const stopping = screen.getByRole("button", { name: STOPPING_LABEL });
    expect(stopping).toBeDisabled();
    expect(screen.queryByRole("button", { name: SYNC_LABEL })).not.toBeInTheDocument();
    fireEvent.click(stopping);
    await flush();
    expect(syncApi.start).toHaveBeenCalledTimes(1);

    // The cancelled run's own request returns: the stop has finished.
    await reply(0, CANCELLED);

    const sync = screen.getByRole("button", { name: SYNC_LABEL });
    expect(sync).toBeEnabled();
    expect(screen.queryByText(STOPPING_LABEL)).not.toBeInTheDocument();
    fireEvent.click(sync);
    await flush();
    expect(syncApi.start).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
  });

  it("C2: the wait is keyed on the reply, not on time — still stopping after 20 s with the request pending", async () => {
    render(<Harness />);
    await connect();
    await startABackup();
    await pressCancel();

    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });
    await flush();

    expect(screen.getByRole("button", { name: STOPPING_LABEL })).toBeDisabled();
    expect(syncApi.start).toHaveBeenCalledTimes(1);

    await reply(0, CANCELLED);
    expect(screen.getByRole("button", { name: SYNC_LABEL })).toBeEnabled();
  });

  it("C2b: a request that ends by throwing also ends the wait", async () => {
    render(<Harness />);
    await connect();
    await startABackup();
    await pressCancel();
    expect(screen.getByRole("button", { name: STOPPING_LABEL })).toBeDisabled();

    // Resolving with a rejected promise rejects the pending request (the hook's catch path).
    await reply(0, Promise.reject(new Error("Sync cancelled")));

    expect(screen.getByRole("button", { name: SYNC_LABEL })).toBeEnabled();
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
  });

  it("C3: main's refusal is still shown when it does arrive (it is not swallowed)", async () => {
    render(<Harness />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: SYNC_LABEL }));
    await flush();

    await reply(0, REFUSAL);

    expect(screen.getByText("Sync Failed")).toBeInTheDocument();
    expect(screen.getByTestId("sync-error-message")).toHaveTextContent("Sync already in progress");
  });

  it("C4: Close on the error screen (no request pending) leaves Sync enabled at once", async () => {
    render(<Harness />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: SYNC_LABEL }));
    await flush();
    await reply(0, REFUSAL);
    expect(screen.getByText("Sync Failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await flush();

    expect(syncApi.cancel).toHaveBeenCalledWith("error-close");
    expect(screen.getByRole("button", { name: SYNC_LABEL })).toBeEnabled();
    expect(screen.queryByText(STOPPING_LABEL)).not.toBeInTheDocument();
  });
});
