/**
 * Tests for ConnectionStatus component.
 *
 * BACKLOG-1919: Covers the Apple-driver recovery view — when no device is
 * detected AND the driver is missing (Windows), the "Connect Your iPhone"
 * screen must show an inline install button that triggers the recovery install,
 * instead of leaving the user stuck with no guidance (root cause of ticket #64).
 *
 * Wrapped in StrictMode per repo convention (StrictMode is ON in main.tsx).
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionStatus } from "../ConnectionStatus";

const renderStrict = (ui: React.ReactElement) =>
  render(<StrictMode>{ui}</StrictMode>);

describe("ConnectionStatus (BACKLOG-1919 driver recovery)", () => {
  it("shows the default Connect view when driver is present", () => {
    renderStrict(
      <ConnectionStatus
        isConnected={false}
        device={null}
        onSyncClick={jest.fn()}
      />,
    );

    expect(screen.getByText("Connect Your iPhone")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /install apple mobile device support/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("shows the inline install button when driverMissing and no device", () => {
    renderStrict(
      <ConnectionStatus
        isConnected={false}
        device={null}
        onSyncClick={jest.fn()}
        driverMissing
        onInstallDriver={jest.fn()}
      />,
    );

    // Silent "Connect Your iPhone" text is replaced by the recovery heading.
    expect(screen.queryByText("Connect Your iPhone")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: /install apple mobile device support/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /install apple mobile device support/i,
      }),
    ).toBeInTheDocument();
  });

  it("invokes onInstallDriver when the inline button is clicked", () => {
    const onInstallDriver = jest.fn();
    renderStrict(
      <ConnectionStatus
        isConnected={false}
        device={null}
        onSyncClick={jest.fn()}
        driverMissing
        onInstallDriver={onInstallDriver}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /install apple mobile device support/i,
      }),
    );
    expect(onInstallDriver).toHaveBeenCalledTimes(1);
  });

  it("shows a spinner (no button) while the install is in progress", () => {
    renderStrict(
      <ConnectionStatus
        isConnected={false}
        device={null}
        onSyncClick={jest.fn()}
        driverMissing
        onInstallDriver={jest.fn()}
        isInstallingDriver
      />,
    );

    // Spinner status text (distinct from the description paragraph).
    expect(
      screen.getByText(/approve the windows permission prompt to continue/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /install apple mobile device support/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("shows the install error when one is provided", () => {
    renderStrict(
      <ConnectionStatus
        isConnected={false}
        device={null}
        onSyncClick={jest.fn()}
        driverMissing
        onInstallDriver={jest.fn()}
        driverInstallError="Installation was cancelled."
      />,
    );

    expect(screen.getByText("Installation was cancelled.")).toBeInTheDocument();
  });

  it("does not show the recovery view once a device is connected", () => {
    renderStrict(
      <ConnectionStatus
        isConnected
        device={{
          udid: "u",
          name: "My iPhone",
          productType: "iPhone14,2",
          productVersion: "17.0",
          serialNumber: "S",
          isConnected: true,
        }}
        onSyncClick={jest.fn()}
        driverMissing
        onInstallDriver={jest.fn()}
      />,
    );

    // Connected view wins; recovery button is not rendered.
    expect(
      screen.queryByRole("button", {
        name: /install apple mobile device support/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("My iPhone")).toBeInTheDocument();
  });
});
