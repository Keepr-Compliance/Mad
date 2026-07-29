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
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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

  it("advances the cursor install -> pair; the pair step has no skip button, Back is available (BACKLOG-2325)", async () => {
    const user = userEvent.setup();
    render(<AndroidSyncSetup userId={USER_ID} />);

    // install
    expect(await screen.findByText("Install Keepr Companion")).toBeInTheDocument();

    // -> pair
    await user.click(screen.getByRole("button", { name: /I've Installed It/i }));
    expect(await screen.findByText("Pair Your Android Phone")).toBeInTheDocument();

    // BACKLOG-2325: the in-step "Skip for now" button is gone — the user either
    // pairs (auto-advance, BACKLOG-2323) or closes the modal. The wizard shell
    // still provides a Back button below the card.
    expect(
      screen.queryByRole("button", { name: /^Skip for now$/i })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Back$/i })).toBeInTheDocument();
    // pair -> done via a live pair is covered by the BACKLOG-2323 suite below.
  });

  it("renders FLUSH with no inner bordered/shadow frame (BACKLOG-2324)", async () => {
    render(<AndroidSyncSetup userId={USER_ID} />);

    const root = await screen.findByTestId("android-sync-setup");

    // The old outer wrapper double-framed the wizard inside the modal.
    expect(root.className).not.toMatch(/\bborder\b/);
    expect(root.className).not.toMatch(/rounded-lg/);
    // The old OnboardingShell white card (bg-white rounded-2xl shadow-xl) is gone,
    // so nothing re-introduces a nested card frame inside the modal.
    expect(root.querySelector(".rounded-2xl.shadow-xl")).toBeNull();
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

  // BACKLOG-2325: the previous "completes via Skip for now, then unmount does not
  // stop the server" test relied on the in-step skip button, which is now removed.
  // That completed-then-unmount lifecycle is still covered without the skip path
  // by "lands on the completed state for a returning already-paired user" (below)
  // and "leaves stopServer UNcalled when a live pair auto-advances the wizard"
  // (BACKLOG-2323 suite), both of which reach "done" and assert stopServer is not
  // called on unmount.

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

  // ---------------------------------------------------------------------------
  // BACKLOG-2323: auto-advance OFF the QR when a phone pairs off it.
  // ---------------------------------------------------------------------------
  describe("auto-advance off the QR on a live pair (BACKLOG-2323)", () => {
    const POLL_MS = 3000; // mirrors PAIR_POLL_INTERVAL_MS in the component
    const AUTO_CLOSE_MS = 2500; // mirrors AUTO_CLOSE_DELAY_MS in the component

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    const device = (deviceId: string) => ({
      deviceId,
      deviceName: `dev-${deviceId}`,
      secret: "s",
      pairedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });

    const statusWith = (deviceIds: string[]) => ({
      success: true,
      status: { isPaired: deviceIds.length > 0, devices: deviceIds.map(device) },
    });

    // Flush pending microtasks + due timers so async effects settle.
    const flush = async () => {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
    };

    // Drive the wizard from the initial install step to the QR/pair step.
    const goToPairStep = async () => {
      await flush(); // render install content + settle mount getStatus
      fireEvent.click(screen.getByRole("button", { name: /I've Installed It/i }));
      await flush(); // land on pair; watcher seeds its baseline device set
      expect(screen.getByText("Pair Your Android Phone")).toBeInTheDocument();
    };

    it("advances to the success screen when a new device pairs (QR no longer rendered)", async () => {
      window.api.pairing.getStatus.mockResolvedValue(statusWith([]));

      render(<AndroidSyncSetup userId={USER_ID} />);
      await goToPairStep();

      // A phone pairs off the QR.
      window.api.pairing.getStatus.mockResolvedValue(statusWith(["new-1"]));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_MS);
      });

      expect(screen.getByText("Android sync is set up")).toBeInTheDocument();
      // The QR/pair step (and thus the consumed QR) is gone.
      expect(screen.queryByText("Pair Your Android Phone")).not.toBeInTheDocument();
    });

    it("auto-closes the modal via onComplete shortly after the success confirmation", async () => {
      const onComplete = jest.fn();
      window.api.pairing.getStatus.mockResolvedValue(statusWith([]));

      render(<AndroidSyncSetup userId={USER_ID} onComplete={onComplete} />);
      await goToPairStep();

      window.api.pairing.getStatus.mockResolvedValue(statusWith(["new-1"]));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_MS);
      });

      // Success is shown first; the modal is not dismissed instantly.
      expect(screen.getByText("Android sync is set up")).toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();

      // After a brief confirmation window, the modal auto-dismisses.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(AUTO_CLOSE_MS);
      });
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it("does NOT auto-advance while no new device appears (no spurious advance)", async () => {
      const onComplete = jest.fn();
      window.api.pairing.getStatus.mockResolvedValue(statusWith([]));

      render(<AndroidSyncSetup userId={USER_ID} onComplete={onComplete} />);
      await goToPairStep();

      // Several polls with an unchanged (empty) paired set.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_MS * 3);
      });

      expect(screen.getByText("Pair Your Android Phone")).toBeInTheDocument();
      expect(screen.queryByText("Android sync is set up")).not.toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
    });

    it("on re-pair, waits for a genuinely NEW device (a stale paired device does not skip the step)", async () => {
      // Returning user already paired with d1 -> lands on the success screen.
      window.api.pairing.getStatus.mockResolvedValue(statusWith(["d1"]));

      render(<AndroidSyncSetup userId={USER_ID} />);
      await flush();
      expect(screen.getByText("Android sync is set up")).toBeInTheDocument();

      // "Pair another device" re-enters the wizard while d1 is still paired.
      fireEvent.click(screen.getByRole("button", { name: /Pair another device/i }));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: /I've Installed It/i }));
      await flush(); // on pair; baseline seeds with the stale d1
      expect(screen.getByText("Pair Your Android Phone")).toBeInTheDocument();

      // The stale d1 persisting across polls must NOT auto-advance.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_MS * 2);
      });
      expect(screen.getByText("Pair Your Android Phone")).toBeInTheDocument();

      // A genuinely new device d2 pairs -> advance.
      window.api.pairing.getStatus.mockResolvedValue(statusWith(["d1", "d2"]));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_MS);
      });
      expect(screen.getByText("Android sync is set up")).toBeInTheDocument();
    });

    it("tears down the pairing watcher on unmount (no polling after unmount)", async () => {
      window.api.pairing.getStatus.mockResolvedValue(statusWith([]));

      const { unmount } = render(<AndroidSyncSetup userId={USER_ID} />);
      await goToPairStep();

      const callsBeforeUnmount = window.api.pairing.getStatus.mock.calls.length;
      unmount();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_MS * 3);
      });

      // Interval cleared on unmount — no further getStatus polls.
      expect(window.api.pairing.getStatus.mock.calls.length).toBe(callsBeforeUnmount);
    });

    // -------------------------------------------------------------------------
    // BACKLOG-2324 SR Note 1: an UNSUCCESSFUL poll must not seed an empty
    // baseline (which would make an already-paired device look "new" and
    // spuriously auto-advance the re-pair flow).
    // -------------------------------------------------------------------------
    it("does not seed a baseline from an unsuccessful poll (no spurious advance on re-pair)", async () => {
      // Returning user already paired with d1 -> lands on the success screen.
      window.api.pairing.getStatus.mockResolvedValue(statusWith(["d1"]));

      render(<AndroidSyncSetup userId={USER_ID} />);
      await flush();
      expect(screen.getByText("Android sync is set up")).toBeInTheDocument();

      // "Pair another device" re-enters the wizard while d1 is still paired.
      fireEvent.click(screen.getByRole("button", { name: /Pair another device/i }));
      await flush();

      // The FIRST poll on entering the pair step FAILS. Pre-fix this seeded an
      // EMPTY baseline; hardened, it is ignored (neither seeds nor compares).
      window.api.pairing.getStatus.mockResolvedValue({ success: false } as never);
      fireEvent.click(screen.getByRole("button", { name: /I've Installed It/i }));
      await flush(); // on pair; the immediate seed tick gets an unsuccessful poll
      expect(screen.getByText("Pair Your Android Phone")).toBeInTheDocument();

      // Subsequent polls succeed and read the STILL-paired d1 (nothing new).
      window.api.pairing.getStatus.mockResolvedValue(statusWith(["d1"]));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_MS * 2);
      });

      // The first SUCCESSFUL poll seeds baseline=[d1]; d1 is not new -> no advance.
      expect(screen.getByText("Pair Your Android Phone")).toBeInTheDocument();
      expect(screen.queryByText("Android sync is set up")).not.toBeInTheDocument();
    });

    // -------------------------------------------------------------------------
    // BACKLOG-2324 SR Note 2: a live-pair AUTO-ADVANCE marks the wizard complete,
    // so unmounting afterwards must NOT halt the now-active sync (stopServer
    // stays uncalled) — the active sync is preserved.
    // -------------------------------------------------------------------------
    it("leaves stopServer UNcalled when a live pair auto-advances the wizard", async () => {
      window.api.pairing.getStatus.mockResolvedValue(statusWith([]));

      const { unmount } = render(<AndroidSyncSetup userId={USER_ID} />);
      await goToPairStep();

      // A phone pairs off the QR -> watcher advances to success (completedRef set).
      window.api.pairing.getStatus.mockResolvedValue(statusWith(["new-1"]));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(POLL_MS);
      });
      expect(screen.getByText("Android sync is set up")).toBeInTheDocument();

      // Unmounting after an auto-advance must NOT stop the active sync server.
      unmount();
      expect(window.api.localSync.stopServer).not.toHaveBeenCalled();
    });
  });
});
