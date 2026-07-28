/**
 * Tests for AndroidSyncSetup (BACKLOG-2289) — the guided install -> pair -> sync
 * wizard embedded in Settings that reuses the onboarding chrome + step content.
 *
 * Covers:
 * - cursor transitions install -> pair -> done
 * - the reused install step's 60s auto-advance is disabled (settings variant)
 * - BACKLOG-2224 account-match: a non-null userId is forwarded to generateQR /
 *   startServer via the synthetic context
 * - server lifecycle: stopServer() on unmount ONLY when pairing was started but
 *   not completed (never halts an already-active/paired sync)
 * - a returning already-paired user lands on the completed state
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { AndroidSyncSetup } from "../AndroidSyncSetup";

// Deterministic QR generation for the reused AndroidDownloadStep (avoids jsdom canvas).
jest.mock("qrcode", () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mock"),
  },
}));

jest.mock("../../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isWindows: false, isMacOS: true })),
}));

const USER_ID = "user-123";

describe("AndroidSyncSetup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("advances the cursor install -> pair -> done", async () => {
    const user = userEvent.setup();
    render(<AndroidSyncSetup userId={USER_ID} />);

    // install
    expect(await screen.findByText("Install Keepr Companion")).toBeInTheDocument();

    // -> pair
    await user.click(screen.getByRole("button", { name: /I've Installed It/i }));
    expect(await screen.findByText("Pair Your Android Phone")).toBeInTheDocument();

    // -> done
    await user.click(screen.getByRole("button", { name: /^Skip for now$/i }));
    expect(await screen.findByText("Android sync is set up")).toBeInTheDocument();
  });

  it("disables the reused install step's auto-advance countdown", async () => {
    render(<AndroidSyncSetup userId={USER_ID} />);

    await screen.findByText("Install Keepr Companion");

    expect(screen.queryByText(/Auto-continuing/i)).not.toBeInTheDocument();
  });

  it("forwards a non-null userId to generateQR + startServer (2224 account-match)", async () => {
    const user = userEvent.setup();
    render(<AndroidSyncSetup userId={USER_ID} />);

    await screen.findByText("Install Keepr Companion");
    await user.click(screen.getByRole("button", { name: /I've Installed It/i }));
    await screen.findByText("Pair Your Android Phone");
    await user.click(screen.getByRole("button", { name: /Show QR Code/i }));

    await waitFor(() => {
      expect(window.api.pairing.generateQR).toHaveBeenCalledWith(USER_ID);
    });
    await waitFor(() => {
      expect(window.api.localSync.startServer).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID })
      );
    });
  });

  it("stops the sync server on unmount when pairing was started but NOT completed", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AndroidSyncSetup userId={USER_ID} />);

    await screen.findByText("Install Keepr Companion");
    // Reach the pair step (a sync server may have been started) but do not finish.
    await user.click(screen.getByRole("button", { name: /I've Installed It/i }));
    await screen.findByText("Pair Your Android Phone");

    unmount();

    expect(window.api.localSync.stopServer).toHaveBeenCalled();
  });

  it("does NOT stop the sync server on unmount after the wizard completes", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AndroidSyncSetup userId={USER_ID} />);

    await screen.findByText("Install Keepr Companion");
    await user.click(screen.getByRole("button", { name: /I've Installed It/i }));
    await screen.findByText("Pair Your Android Phone");
    await user.click(screen.getByRole("button", { name: /^Skip for now$/i }));
    await screen.findByText("Android sync is set up");

    unmount();

    expect(window.api.localSync.stopServer).not.toHaveBeenCalled();
  });

  it("lands on the completed state for a returning already-paired user", async () => {
    window.api.pairing.getStatus.mockResolvedValueOnce({
      success: true,
      status: {
        isPaired: true,
        devices: [
          {
            deviceId: "d1",
            deviceName: "Pixel 8",
            secret: "s",
            pairedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          },
        ],
      },
    });

    const { unmount } = render(<AndroidSyncSetup userId={USER_ID} />);

    expect(await screen.findByText("Android sync is set up")).toBeInTheDocument();

    // Never halt an already-active/paired sync.
    unmount();
    expect(window.api.localSync.stopServer).not.toHaveBeenCalled();
  });
});
