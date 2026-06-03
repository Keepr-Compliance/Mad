/**
 * Tests for iPhone Connection UI Components
 * Covers ConnectionStatus, DeviceInfo, BackupPasswordModal, TrustComputerHint, and SyncProgress
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ConnectionStatus } from "../ConnectionStatus";
import { DeviceInfo } from "../DeviceInfo";
import { BackupPasswordModal } from "../BackupPasswordModal";
import { TrustComputerHint } from "../TrustComputerHint";
import { SyncProgress } from "../SyncProgress";
import type { iOSDevice, BackupProgress } from "../../../types/iphone";

// Mock device data
const mockDevice: iOSDevice = {
  udid: "abc123",
  name: "Daniel's iPhone",
  productType: "iPhone14,2",
  productVersion: "17.0",
  serialNumber: "XYZ789",
  isConnected: true,
};

describe("TrustComputerHint", () => {
  it("should render connection instructions", () => {
    render(<TrustComputerHint />);

    expect(screen.getByText(/don't see your iphone/i)).toBeInTheDocument();
    expect(screen.getByText(/1. Unlock your iPhone/i)).toBeInTheDocument();
    expect(
      screen.getByText(/2. Tap "Trust" when prompted/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/iOS asks every session/i)).toBeInTheDocument();
    expect(
      screen.getByText(/3. Enter your iPhone passcode/i),
    ).toBeInTheDocument();
  });
});

describe("ConnectionStatus", () => {
  const mockOnSyncClick = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("when disconnected", () => {
    it("should show connection instructions", () => {
      render(
        <ConnectionStatus
          isConnected={false}
          device={null}
          onSyncClick={mockOnSyncClick}
        />,
      );

      expect(
        screen.getByRole("heading", { name: /connect your iphone/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/connect your iphone using a usb cable/i),
      ).toBeInTheDocument();
    });

    it("should show trust computer hint", () => {
      render(
        <ConnectionStatus
          isConnected={false}
          device={null}
          onSyncClick={mockOnSyncClick}
        />,
      );

      expect(screen.getByText(/don't see your iphone/i)).toBeInTheDocument();
    });

    it("should not show sync button when disconnected", () => {
      render(
        <ConnectionStatus
          isConnected={false}
          device={null}
          onSyncClick={mockOnSyncClick}
        />,
      );

      expect(
        screen.queryByRole("button", { name: /sync messages/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("when connected", () => {
    it("should show device name", () => {
      render(
        <ConnectionStatus
          isConnected={true}
          device={mockDevice}
          onSyncClick={mockOnSyncClick}
        />,
      );

      expect(screen.getByText("Daniel's iPhone")).toBeInTheDocument();
    });

    it("should show iOS version", () => {
      render(
        <ConnectionStatus
          isConnected={true}
          device={mockDevice}
          onSyncClick={mockOnSyncClick}
        />,
      );

      expect(screen.getByText(/iOS 17.0/i)).toBeInTheDocument();
    });

    it("should show sync button", () => {
      render(
        <ConnectionStatus
          isConnected={true}
          device={mockDevice}
          onSyncClick={mockOnSyncClick}
        />,
      );

      expect(
        screen.getByRole("button", { name: /sync messages & contacts/i }),
      ).toBeInTheDocument();
    });

    it("should call onSyncClick when sync button is clicked", async () => {
      render(
        <ConnectionStatus
          isConnected={true}
          device={mockDevice}
          onSyncClick={mockOnSyncClick}
        />,
      );

      const syncButton = screen.getByRole("button", {
        name: /sync messages & contacts/i,
      });
      await userEvent.click(syncButton);

      expect(mockOnSyncClick).toHaveBeenCalledTimes(1);
    });

    it("should show fallback name when device name is empty", () => {
      const deviceWithoutName = { ...mockDevice, name: "" };
      render(
        <ConnectionStatus
          isConnected={true}
          device={deviceWithoutName}
          onSyncClick={mockOnSyncClick}
        />,
      );

      expect(screen.getByText("iPhone")).toBeInTheDocument();
    });
  });
});

describe("DeviceInfo", () => {
  it("should display device name", () => {
    render(<DeviceInfo device={mockDevice} />);

    expect(screen.getByText("Daniel's iPhone")).toBeInTheDocument();
  });

  it("should display iOS version", () => {
    render(<DeviceInfo device={mockDevice} />);

    expect(screen.getByText("17.0")).toBeInTheDocument();
  });

  it("should display friendly model name for known product types", () => {
    render(<DeviceInfo device={mockDevice} />);

    expect(screen.getByText("iPhone 13 Pro")).toBeInTheDocument();
  });

  it("should display product type for unknown models", () => {
    const unknownDevice = { ...mockDevice, productType: "iPhone99,9" };
    render(<DeviceInfo device={unknownDevice} />);

    expect(screen.getByText("iPhone99,9")).toBeInTheDocument();
  });

  it("should display serial number", () => {
    render(<DeviceInfo device={mockDevice} />);

    expect(screen.getByText("XYZ789")).toBeInTheDocument();
  });
});

describe("BackupPasswordModal", () => {
  const mockOnSubmit = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should not render when isOpen is false", () => {
    render(
      <BackupPasswordModal
        isOpen={false}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    expect(
      screen.queryByText(/backup password required/i),
    ).not.toBeInTheDocument();
  });

  it("should render when isOpen is true", () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    expect(screen.getByText(/backup password required/i)).toBeInTheDocument();
  });

  it("should show device name in message", () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    expect(
      screen.getByText(/Test iPhone backup is encrypted/i),
    ).toBeInTheDocument();
  });

  it("should have password input field", () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    expect(screen.getByPlaceholderText(/backup password/i)).toBeInTheDocument();
  });

  it("should disable submit button when password is empty", () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    const submitButton = screen.getByRole("button", { name: /continue/i });
    expect(submitButton).toBeDisabled();
  });

  it("should enable submit button when password is entered", async () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    const input = screen.getByPlaceholderText(/backup password/i);
    await userEvent.type(input, "mypassword");

    const submitButton = screen.getByRole("button", { name: /continue/i });
    expect(submitButton).not.toBeDisabled();
  });

  it("should call onSubmit with password when form is submitted", async () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    const input = screen.getByPlaceholderText(/backup password/i);
    await userEvent.type(input, "mypassword");

    const submitButton = screen.getByRole("button", { name: /continue/i });
    await userEvent.click(submitButton);

    expect(mockOnSubmit).toHaveBeenCalledWith("mypassword");
  });

  it("should call onCancel when cancel button is clicked", async () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    const cancelButton = screen.getByRole("button", { name: /cancel/i });
    await userEvent.click(cancelButton);

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("should call onCancel when X button is clicked", async () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    // X button is the close button in the header with aria-label
    const closeButton = screen.getByRole("button", { name: /close/i });
    await userEvent.click(closeButton);

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("should display error message when error prop is provided", () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
        error="Incorrect password"
      />,
    );

    expect(screen.getByText("Incorrect password")).toBeInTheDocument();
  });

  it("should show loading state when isLoading is true", () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
        isLoading={true}
      />,
    );

    expect(screen.getByText(/verifying/i)).toBeInTheDocument();
  });

  it("should call onCancel when cancel button is clicked", () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: /cancel/i })[0]);

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("should show help text about backup password", () => {
    render(
      <BackupPasswordModal
        isOpen={true}
        deviceName="Test iPhone"
        onSubmit={mockOnSubmit}
        onCancel={mockOnCancel}
      />,
    );

    expect(screen.getByText(/encrypt iphone backup/i)).toBeInTheDocument();
  });
});

describe("SyncProgress", () => {
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should show preparing phase", () => {
    const progress: BackupProgress = {
      phase: "preparing",
      percent: 0,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    expect(screen.getByText(/preparing export/i)).toBeInTheDocument();
  });

  it("should show backing up phase", () => {
    const progress: BackupProgress = {
      phase: "backing_up",
      percent: 25,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    // Option C 2-tier UI shows combined title+context
    expect(screen.getByText(/exporting/i)).toBeInTheDocument();
    expect(screen.getByText(/keep connected/i)).toBeInTheDocument();
  });

  it("should show extracting phase", () => {
    const progress: BackupProgress = {
      phase: "extracting",
      percent: 75,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    // Option C 2-tier UI shows combined title+context
    expect(screen.getByText(/reading messages/i)).toBeInTheDocument();
    expect(screen.getByText(/safe to disconnect/i)).toBeInTheDocument();
  });

  it("should show complete phase", () => {
    const progress: BackupProgress = {
      phase: "complete",
      percent: 100,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    expect(screen.getByText(/sync complete/i)).toBeInTheDocument();
  });

  it("should show error phase", () => {
    const progress: BackupProgress = {
      phase: "error",
      percent: 50,
      message: "Connection lost",
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    // Option C 2-tier UI shows "Sync failed" for error phase
    expect(screen.getByText(/sync failed/i)).toBeInTheDocument();
  });

  it("should show progress percentage during extracting phase", () => {
    const progress: BackupProgress = {
      phase: "extracting",
      percent: 45,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    // Current UI shows "X% complete" during extracting/storing phases
    expect(screen.getByText(/45% complete/i)).toBeInTheDocument();
  });

  it("should show progress message when provided", () => {
    const progress: BackupProgress = {
      phase: "backing_up",
      percent: 45,
      message: "Backing up photos...",
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    expect(screen.getByText("Backing up photos...")).toBeInTheDocument();
  });

  it("should show file count when provided", () => {
    const progress: BackupProgress = {
      phase: "extracting",
      percent: 60,
      processedFiles: 150,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    // Current UI shows "• X files" format
    expect(screen.getByText(/150 files/i)).toBeInTheDocument();
  });

  it("should show cancel button during active sync", () => {
    const progress: BackupProgress = {
      phase: "backing_up",
      percent: 25,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("should call onCancel when cancel button is clicked", async () => {
    const progress: BackupProgress = {
      phase: "backing_up",
      percent: 25,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it("should not show cancel button when complete", () => {
    const progress: BackupProgress = {
      phase: "complete",
      percent: 100,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    expect(
      screen.queryByRole("button", { name: /cancel/i }),
    ).not.toBeInTheDocument();
  });

  it("should not show cancel button when error", () => {
    const progress: BackupProgress = {
      phase: "error",
      percent: 50,
    };

    render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

    expect(
      screen.queryByRole("button", { name: /cancel/i }),
    ).not.toBeInTheDocument();
  });

  describe("backup phase progress display", () => {
    it("should never show size estimate during backup phase (estimates are unreliable)", () => {
      const progress: BackupProgress = {
        phase: "backing_up",
        percent: 50,
        bytesProcessed: 1_000_000_000, // 1 GB
        estimatedTotalBytes: 2_000_000_000, // 2 GB
      };

      render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

      // Should NOT show estimate text even when estimate is available
      expect(screen.queryByText(/\/ ~/)).not.toBeInTheDocument();
      // Should NOT show percentage (always indeterminate during backup)
      expect(screen.queryByText(/50%/)).not.toBeInTheDocument();
      // Should show transferred amount
      expect(screen.getByText(/transferred/)).toBeInTheDocument();
    });

    it("should show only transferred amount when bytesProcessed exceeds estimate", () => {
      const progress: BackupProgress = {
        phase: "backing_up",
        percent: 99,
        bytesProcessed: 10_700_000_000, // 10.7 GB - exceeds estimate
        estimatedTotalBytes: 1_900_000_000, // 1.9 GB
      };

      render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

      expect(screen.queryByText(/\/ ~/)).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
      expect(screen.getByText(/transferred/)).toBeInTheDocument();
    });

    it("should show indeterminate bar when estimatedTotalBytes is 0", () => {
      const progress: BackupProgress = {
        phase: "backing_up",
        percent: 0,
        bytesProcessed: 500_000_000,
        estimatedTotalBytes: 0,
      };

      render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

      expect(screen.queryByText(/\/ ~/)).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    });

    it("should show indeterminate bar when estimatedTotalBytes is undefined", () => {
      const progress: BackupProgress = {
        phase: "backing_up",
        percent: 0,
        bytesProcessed: 500_000_000,
      };

      render(<SyncProgress progress={progress} onCancel={mockOnCancel} />);

      // Should NOT show estimate text
      expect(screen.queryByText(/\/ ~/)).not.toBeInTheDocument();
      // Should NOT show percentage
      expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    });
  });
});
