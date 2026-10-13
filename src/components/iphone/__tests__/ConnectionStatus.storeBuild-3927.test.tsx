/**
 * BACKLOG-3927: on the Connect Your iPhone screen, a Microsoft Store build with
 * the driver missing shows the Apple Devices guide (Open Microsoft Store /
 * Check again) instead of "Install Apple Mobile Device Support".
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ConnectionStatus } from "../ConnectionStatus";
import {
  APPLE_DEVICES_CHECK_BUTTON,
  APPLE_DEVICES_HEADING,
  APPLE_DEVICES_NOT_FOUND,
} from "../../../constants/appleDevicesStoreCopy";

const base = { isConnected: false, device: null, onSyncClick: jest.fn(), driverMissing: true };

beforeEach(() => jest.clearAllMocks());

it("Store build: Apple Devices guide; Check again calls the re-check", async () => {
  const onInstallDriver = jest.fn();
  const onRecheckDriver = jest.fn(async () => false);
  render(
    <ConnectionStatus {...base} isStoreBuild onInstallDriver={onInstallDriver} onRecheckDriver={onRecheckDriver} />,
  );
  expect(screen.getByText(APPLE_DEVICES_HEADING)).toBeInTheDocument();
  expect(screen.queryByText("Install Apple Mobile Device Support")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: APPLE_DEVICES_CHECK_BUTTON }));
  expect(onRecheckDriver).toHaveBeenCalled();
  expect(await screen.findByText(APPLE_DEVICES_NOT_FOUND)).toBeInTheDocument();
  expect(onInstallDriver).not.toHaveBeenCalled();
});

it("Store build without a re-check handler never falls back to the installer view", () => {
  render(<ConnectionStatus {...base} isStoreBuild onInstallDriver={jest.fn()} />);
  expect(screen.queryByText("Install Apple Mobile Device Support")).not.toBeInTheDocument();
  expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
});

it("website build unchanged: Install Apple Mobile Device Support", () => {
  render(<ConnectionStatus {...base} onInstallDriver={jest.fn()} onRecheckDriver={jest.fn()} />);
  expect(screen.getByRole("button", { name: "Install Apple Mobile Device Support" })).toBeInTheDocument();
  expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
});

it("Windows on ARM still wins over the Store guide (BACKLOG-3363 unchanged)", () => {
  render(<ConnectionStatus {...base} isWindowsArm64 isStoreBuild onRecheckDriver={jest.fn()} />);
  expect(screen.getByTestId("windows-arm64-unsupported")).toBeInTheDocument();
  expect(screen.queryByText(APPLE_DEVICES_HEADING)).not.toBeInTheDocument();
});
