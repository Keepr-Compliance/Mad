/**
 * BACKLOG-3816 — the banner shows `sync:progress` phase "cleanup" ticks (securing the
 * kept iPhone backup, emitted by S4-C) when no iPhone sync is active.
 *
 * The real atRestMigrationService runs; only the preload bridge is synthetic. The
 * event shape is the one deviceSyncOrchestrator.watchBackupAtRestProgress emits:
 *   { phase: "cleanup", phaseProgress: percent, overallProgress: percent, message }
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";

import { syncStateRef } from "../../../hooks/useIPhoneSync";
import { toBackupSecuringProgress } from "../../../services/atRestMigrationService";
import { AtRestMigrationBanner, BACKUP_DONE_VISIBLE_MS, BACKUP_STALE_MS } from "../AtRestMigrationBanner";

let emitProgress: ((p: unknown) => void) | null = null;
let originalApi: unknown;

const cleanup = (percent: number) => ({
  phase: "cleanup",
  phaseProgress: percent,
  overallProgress: percent,
  message: `Securing your iPhone backup… ${percent}%`,
});

function emit(p: unknown) {
  act(() => emitProgress?.(p));
}

beforeEach(() => {
  syncStateRef.isActive = false;
  emitProgress = null;
  const w = window as unknown as { api?: unknown };
  originalApi = w.api;
  w.api = {
    atRest: {
      getMigrationStatus: jest.fn(async () => ({ phase: "idle", done: 0, total: 0, minutesLeft: null, encryptedThisLaunch: 0 })),
      onMigrationStatus: jest.fn(() => () => undefined),
    },
    sync: {
      onProgress: jest.fn((cb: (p: unknown) => void) => {
        emitProgress = cb;
        return () => {
          emitProgress = null;
        };
      }),
    },
  };
});

afterEach(() => {
  (window as unknown as { api?: unknown }).api = originalApi;
  syncStateRef.isActive = false;
  jest.useRealTimers();
});

describe("AtRestMigrationBanner — securing the iPhone backup", () => {
  it("no sync active: a cleanup tick shows its message, and the next tick replaces it", async () => {
    render(<AtRestMigrationBanner />);
    await act(async () => undefined);
    expect(screen.queryByTestId("at-rest-backup-securing")).toBeNull();

    emit(cleanup(42));
    expect(screen.getByTestId("at-rest-backup-securing")).toHaveTextContent("Securing your iPhone backup… 42%");

    emit(cleanup(43));
    expect(screen.getByTestId("at-rest-backup-securing")).toHaveTextContent("Securing your iPhone backup… 43%");
  });

  it("an iPhone sync is active: the tick is left to the sync screen", async () => {
    syncStateRef.isActive = true;
    render(<AtRestMigrationBanner />);
    await act(async () => undefined);
    emit(cleanup(42));
    expect(screen.queryByTestId("at-rest-backup-securing")).toBeNull();
  });

  it("other sync:progress phases are not shown", async () => {
    render(<AtRestMigrationBanner />);
    await act(async () => undefined);
    emit({ phase: "storing", overallProgress: 50, message: "Saving messages" });
    emit({ phase: "backup", overallProgress: 10, message: "Backing up" });
    expect(screen.queryByTestId("at-rest-backup-securing")).toBeNull();
  });

  it("hides after reaching 100%, and after ticks stop", async () => {
    jest.useFakeTimers();
    render(<AtRestMigrationBanner />);
    await act(async () => undefined);

    emit(cleanup(100));
    expect(screen.getByText("Securing your iPhone backup… 100%")).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(BACKUP_DONE_VISIBLE_MS + 1));
    expect(screen.queryByTestId("at-rest-backup-securing")).toBeNull();

    emit(cleanup(7));
    act(() => jest.advanceTimersByTime(BACKUP_DONE_VISIBLE_MS + 1));
    expect(screen.getByTestId("at-rest-backup-securing")).toBeInTheDocument();
    act(() => jest.advanceTimersByTime(BACKUP_STALE_MS));
    expect(screen.queryByTestId("at-rest-backup-securing")).toBeNull();
  });
});

describe("toBackupSecuringProgress", () => {
  it("accepts only cleanup ticks with a message; clamps percent", () => {
    expect(toBackupSecuringProgress(cleanup(5))).toEqual({ message: "Securing your iPhone backup… 5%", percent: 5 });
    expect(toBackupSecuringProgress({ phase: "cleanup", overallProgress: 140, message: "m" })).toEqual({ message: "m", percent: 100 });
    expect(toBackupSecuringProgress({ phase: "cleanup", overallProgress: 5 })).toBeNull();
    expect(toBackupSecuringProgress({ phase: "storing", overallProgress: 5, message: "m" })).toBeNull();
    expect(toBackupSecuringProgress(null)).toBeNull();
    expect(toBackupSecuringProgress("cleanup")).toBeNull();
  });
});
