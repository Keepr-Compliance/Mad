/**
 * BACKLOG-3927: "Keep your iPhone unlocked" shows ONLY while the backup reports
 * the device has not started sending files (isWaitingForPasscode), in both
 * builds. Measured 2026-10-12: the transfer waited ~15 min until the phone was
 * unlocked.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SyncProgress } from "../SyncProgress";
import type { BackupProgress } from "../../../types/iphone";
import { SYNC_KEEP_UNLOCKED_HINT } from "../../../constants/appleDevicesStoreCopy";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const PHASES: BackupProgress["phase"][] = ["preparing", "backing_up", "extracting", "storing", "complete", "error"];

it("shows the unlock hint while the device has not started sending", () => {
  render(
    <SyncProgress
      progress={{ phase: "backing_up", percent: 0, message: "Your iPhone is preparing the export..." }}
      isWaitingForPasscode
    />,
  );
  expect(screen.getByTestId("sync-keep-unlocked-hint")).toHaveTextContent(SYNC_KEEP_UNLOCKED_HINT);
  expect(SYNC_KEEP_UNLOCKED_HINT).toMatch(/unlocked/);
});

it.each(PHASES)("no unlock hint in phase %s when the device is sending (or done)", (phase) => {
  render(<SyncProgress progress={{ phase, percent: 10, message: "x", bytesProcessed: 1024 }} />);
  expect(screen.queryByTestId("sync-keep-unlocked-hint")).not.toBeInTheDocument();
  expect(screen.queryByText(SYNC_KEEP_UNLOCKED_HINT)).not.toBeInTheDocument();
});
