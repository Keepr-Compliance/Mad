/**
 * BACKLOG-3816 S3 — the background-encryption banner.
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";

import type { AtRestMigrationStatus } from "../../../../electron/types/ipc/window-api-at-rest";

let pushed: ((s: AtRestMigrationStatus) => void) | null = null;
let initial: AtRestMigrationStatus | null = null;

jest.mock("../../../services/atRestMigrationService", () => ({
  atRestMigrationService: {
    getStatus: jest.fn(async () => initial),
    subscribe: jest.fn((cb: (s: AtRestMigrationStatus) => void) => {
      pushed = cb;
      return () => {
        pushed = null;
      };
    }),
    subscribeBackupSecuring: jest.fn(() => () => undefined),
  },
}));

import { AtRestMigrationBanner, COPY, formatDetails } from "../AtRestMigrationBanner";

const base: AtRestMigrationStatus = { phase: "running", done: 0, total: 0, minutesLeft: null, encryptedThisLaunch: 0 };

function push(s: Partial<AtRestMigrationStatus>) {
  act(() => pushed?.({ ...base, ...s }));
}

beforeEach(() => {
  pushed = null;
  initial = null;
  jest.useRealTimers();
});

describe("AtRestMigrationBanner", () => {
  it("renders nothing when idle or with nothing to do", async () => {
    initial = { ...base, phase: "idle" };
    const { container } = render(<AtRestMigrationBanner />);
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
    push({ phase: "done", total: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it("running: founder copy and '{done} of {total} files · about {n} minutes left'", async () => {
    render(<AtRestMigrationBanner />);
    await act(async () => undefined);
    push({ phase: "running", done: 12, total: 840, minutesLeft: 3 });
    expect(
      screen.getByText(
        "Securing your saved data — Keepr is encrypting files it saved on this computer. You can keep working.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("12 of 840 files · about 3 minutes left")).toBeInTheDocument();
  });

  it("paused for disk space and for files in use show plain messages", async () => {
    render(<AtRestMigrationBanner />);
    await act(async () => undefined);
    push({ phase: "paused", pauseReason: "disk-space", done: 1, total: 5 });
    expect(screen.getByText(COPY.pausedDisk)).toBeInTheDocument();
    push({ phase: "paused", pauseReason: "files-in-use", done: 4, total: 5 });
    expect(screen.getByText(COPY.pausedInUse)).toBeInTheDocument();
  });

  it("done after work this launch: 'Your saved files are now encrypted.', then hides", async () => {
    jest.useFakeTimers();
    render(<AtRestMigrationBanner />);
    await act(async () => undefined);
    push({ phase: "running", done: 4, total: 5 });
    push({ phase: "done", done: 5, total: 5, minutesLeft: 0, encryptedThisLaunch: 5 });
    expect(screen.getByText("Your saved files are now encrypted.")).toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(9000);
    });
    expect(screen.queryByTestId("at-rest-migration-banner")).toBeNull();
  });

  it("the status read on mount is shown when no push has arrived", async () => {
    initial = { ...base, phase: "running", done: 2, total: 9, minutesLeft: null };
    render(<AtRestMigrationBanner />);
    await act(async () => undefined);
    expect(screen.getByText("2 of 9 files")).toBeInTheDocument();
  });

  it("formatDetails: singular minute, and at least 1 minute while running", () => {
    expect(formatDetails({ ...base, done: 1, total: 2, minutesLeft: 1 })).toBe("1 of 2 files · about 1 minute left");
    expect(formatDetails({ ...base, done: 1, total: 2, minutesLeft: 0 })).toBe("1 of 2 files · about 1 minute left");
  });
});
