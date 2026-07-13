/**
 * Tests for SyncToolsSettings.tsx
 * Covers driver status display, install/repair actions, progress, and platform gate.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { SyncToolsSettings } from "../SyncToolsSettings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to override driver mock return values */
function mockCheckApple(overrides: Partial<{
  isInstalled: boolean;
  version: string | null;
  serviceRunning: boolean;
  error: string | null;
}> = {}) {
  const defaults = {
    isInstalled: false,
    version: null,
    serviceRunning: false,
    error: null,
  };
  (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue({
    ...defaults,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SyncToolsSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: drivers not installed
    mockCheckApple();
    (window.api.drivers!.installApple as jest.Mock).mockResolvedValue({
      success: true,
      error: null,
      rebootRequired: false,
    });
  });

  // ------- Rendering States -------

  it("should render description (BACKLOG-1937: no own heading — renders inside iPhone Sync category)", async () => {
    render(<SyncToolsSettings />);

    // The section wrapper + "Sync Tools" <h3> was removed; it's now a plain panel.
    expect(screen.queryByText("Sync Tools")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByText(/iPhone sync requires Apple Mobile Device Support/),
      ).toBeInTheDocument();
    });
  });

  // ------- BACKLOG-1937: disabled (import source ≠ iPhone) -------

  it("should disable the Install button when disabled prop is set", async () => {
    mockCheckApple({ isInstalled: false });

    render(<SyncToolsSettings disabled />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /install sync tools/i }),
      ).toBeDisabled();
    });
  });

  it("should disable the Repair button when disabled prop is set", async () => {
    mockCheckApple({ isInstalled: true, version: "12.0", serviceRunning: false });

    render(<SyncToolsSettings disabled />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /repair installation/i }),
      ).toBeDisabled();
    });
  });

  it("should keep the Install button enabled when not disabled", async () => {
    mockCheckApple({ isInstalled: false });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /install sync tools/i }),
      ).not.toBeDisabled();
    });
  });

  it("should show 'Checking...' while loading", () => {
    // Never resolve to keep loading state
    (window.api.drivers!.checkApple as jest.Mock).mockImplementation(
      () => new Promise(() => {}),
    );

    render(<SyncToolsSettings />);

    expect(screen.getByText("Checking...")).toBeInTheDocument();
  });

  it("should render 'Not Installed' when drivers are missing", async () => {
    mockCheckApple({ isInstalled: false });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Not Installed")).toBeInTheDocument();
    });
  });

  it("should render 'Installed (v{version})' when drivers are present", async () => {
    mockCheckApple({ isInstalled: true, version: "12.11.3.6", serviceRunning: true });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Installed (v12.11.3.6)")).toBeInTheDocument();
    });
  });

  it("should render 'Installed' without version when version is null", async () => {
    mockCheckApple({ isInstalled: true, version: null, serviceRunning: true });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Installed")).toBeInTheDocument();
    });
  });

  it("should show service status 'Running' in green when drivers installed and service running", async () => {
    mockCheckApple({ isInstalled: true, version: "12.0", serviceRunning: true });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Running")).toBeInTheDocument();
    });
    expect(screen.getByText("Running")).toHaveClass("text-green-600");
  });

  it("should show service status 'Stopped' in amber when service not running", async () => {
    mockCheckApple({ isInstalled: true, version: "12.0", serviceRunning: false });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Stopped")).toBeInTheDocument();
    });
    expect(screen.getByText("Stopped")).toHaveClass("text-amber-600");
  });

  it("should show error status when check returns an error", async () => {
    mockCheckApple({ isInstalled: false, error: "Registry access denied" });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Error: Registry access denied")).toBeInTheDocument();
    });
  });

  // ------- Action Buttons -------

  it("should show 'Install Sync Tools' button when not installed", async () => {
    mockCheckApple({ isInstalled: false });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });
  });

  it("should NOT show install button when drivers are installed", async () => {
    mockCheckApple({ isInstalled: true, version: "12.0", serviceRunning: true });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Running")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Install Sync Tools" })).not.toBeInTheDocument();
  });

  it("should show 'Repair Installation' button when installed but service stopped", async () => {
    mockCheckApple({ isInstalled: true, version: "12.0", serviceRunning: false });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Repair Installation" })).toBeInTheDocument();
    });
  });

  it("should NOT show repair button when service is running", async () => {
    mockCheckApple({ isInstalled: true, version: "12.0", serviceRunning: true });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Running")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Repair Installation" })).not.toBeInTheDocument();
  });

  // ------- Installation Flow -------

  it("should show progress indicator after confirming install", async () => {
    mockCheckApple({ isInstalled: false });

    // Make install hang so we can observe progress
    (window.api.drivers!.installApple as jest.Mock).mockImplementation(
      () => new Promise(() => {}),
    );

    const user = userEvent.setup();
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    // Progress bar should appear
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("should show success message after confirming and successfully installing", async () => {
    mockCheckApple({ isInstalled: false });

    jest.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("Sync tools installed successfully.")).toBeInTheDocument();
    });

    jest.useRealTimers();
  });

  it("should show error message after confirming a failed installation", async () => {
    mockCheckApple({ isInstalled: false });

    (window.api.drivers!.installApple as jest.Mock).mockResolvedValue({
      success: false,
      error: "User cancelled UAC prompt",
      rebootRequired: false,
    });

    const user = userEvent.setup();
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("User cancelled UAC prompt")).toBeInTheDocument();
    });
  });

  it("should show fallback error when install throws after confirming", async () => {
    mockCheckApple({ isInstalled: false });

    (window.api.drivers!.installApple as jest.Mock).mockRejectedValue(
      new Error("IPC channel not available"),
    );

    const user = userEvent.setup();
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(screen.getByText("IPC channel not available")).toBeInTheDocument();
    });
  });

  it("should call drivers.installApple when install button is clicked", async () => {
    mockCheckApple({ isInstalled: false });

    const user = userEvent.setup();
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));

    expect(window.api.drivers!.installApple).not.toHaveBeenCalled();
  });

  // ------- BACKLOG-1943: install confirmation gate -------

  it("should show the confirmation prompt (not call installApple) when Install is clicked", async () => {
    mockCheckApple({ isInstalled: false });

    const user = userEvent.setup();
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));

    expect(
      screen.getByText(/Windows will ask you to approve the installation/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(window.api.drivers!.installApple).not.toHaveBeenCalled();
  });

  it("should call installApple exactly once after clicking Continue", async () => {
    mockCheckApple({ isInstalled: false });

    const user = userEvent.setup();
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(window.api.drivers!.installApple).toHaveBeenCalledTimes(1);
  });

  it("should hide the confirmation and never call installApple when Cancel is clicked", async () => {
    mockCheckApple({ isInstalled: false });

    const user = userEvent.setup();
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByText(/Windows will ask you to approve the installation/i),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    expect(window.api.drivers!.installApple).not.toHaveBeenCalled();
  });

  it("should show the confirmation prompt for Repair Installation too", async () => {
    mockCheckApple({ isInstalled: true, version: "12.0", serviceRunning: false });

    const user = userEvent.setup();
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Repair Installation" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Repair Installation" }));

    expect(
      screen.getByText(/Windows will ask you to approve the installation/i),
    ).toBeInTheDocument();
    expect(window.api.drivers!.installApple).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(window.api.drivers!.installApple).toHaveBeenCalledTimes(1);
  });

  it("should reset the confirmation prompt when the card becomes disabled and re-enabled (BACKLOG-1943)", async () => {
    mockCheckApple({ isInstalled: false });

    const user = userEvent.setup();
    const { rerender } = render(<SyncToolsSettings disabled={false} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Install Sync Tools" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // Import source switches away from iPhone: card becomes disabled and the
    // confirm block unmounts via its `!disabled` render gate.
    rerender(<SyncToolsSettings disabled={true} />);

    // Switch back to iPhone: should NOT resurrect the stale confirm prompt.
    rerender(<SyncToolsSettings disabled={false} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install Sync Tools" })).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Windows will ask you to approve the installation/i),
    ).not.toBeInTheDocument();
    expect(window.api.drivers!.installApple).not.toHaveBeenCalled();
  });

  it("should call drivers.checkApple on mount", async () => {
    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(window.api.drivers!.checkApple).toHaveBeenCalled();
    });
  });

  // ------- Service status not shown when not installed -------

  it("should NOT show service status row when drivers are not installed", async () => {
    mockCheckApple({ isInstalled: false });

    render(<SyncToolsSettings />);

    await waitFor(() => {
      expect(screen.getByText("Not Installed")).toBeInTheDocument();
    });
    expect(screen.queryByText("Service Status")).not.toBeInTheDocument();
  });
});
