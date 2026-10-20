/**
 * BACKLOG-4002 (N7 + SR N6) — while the backup tool is suspended, the sync screen shows
 * the notice and NEITHER waiting panel: not the amber "please don't disconnect or
 * cancel" one, and not the gray "keep your iPhone connected" one. An implementation that
 * hid the amber panel by clearing isWaitingForPasscode would bring the gray one back;
 * the second state below catches that. Cancel stays.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { SyncProgress } from "../SyncProgress";
import type { BackupProgress, UserFacingError } from "../../../types/iphone";
import { formatToolSuspendedNotice } from "../../../../electron/services/diagnostics/userFacingErrors";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// The exact object main sends, not a hand-written copy.
const NOTICE: UserFacingError = formatToolSuspendedNotice("C:\\Program Files\\Keepr");
const AMBER = /please don.t disconnect or cancel/i;
const GRAY = "Please keep your iPhone connected until export completes.";

const waiting: BackupProgress = { phase: "backing_up", percent: 0, message: "Your iPhone is preparing the export..." };

describe("BACKLOG-4002 SyncProgress: the suspended notice", () => {
  it.each([
    ["while the device wait was showing (isWaitingForPasscode)", true],
    ["while the gray panel would show (not waiting)", false],
  ])("%s: the notice, and neither panel; Cancel stays", (_name, isWaitingForPasscode) => {
    render(
      <SyncProgress progress={waiting} onCancel={jest.fn()} isWaitingForPasscode={isWaitingForPasscode} toolSuspendedNotice={NOTICE} />,
    );
    const notice = screen.getByTestId("tool-suspended-notice");
    expect(within(notice).getByText("Your antivirus may have paused the backup")).toBeInTheDocument();
    expect(within(notice).getByText("If the backup does not continue within a minute, select Cancel, then Try Again.")).toBeInTheDocument();
    expect(within(notice).getByText("If this keeps happening, contact support.")).toBeInTheDocument();
    expect(screen.queryByText(AMBER)).not.toBeInTheDocument();
    expect(screen.queryByText(GRAY)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("resumed (no notice): the amber panel is back", () => {
    render(<SyncProgress progress={waiting} onCancel={jest.fn()} isWaitingForPasscode toolSuspendedNotice={null} />);
    expect(screen.queryByTestId("tool-suspended-notice")).not.toBeInTheDocument();
    expect(screen.getByText(AMBER)).toBeInTheDocument();
  });

  it("resumed while not waiting: the gray panel is back", () => {
    render(<SyncProgress progress={waiting} onCancel={jest.fn()} toolSuspendedNotice={null} />);
    expect(screen.getByText(GRAY)).toBeInTheDocument();
  });
});
