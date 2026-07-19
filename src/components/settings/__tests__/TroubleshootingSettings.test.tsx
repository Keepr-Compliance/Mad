/**
 * Tests for TroubleshootingSettings.tsx (BACKLOG-2112)
 *
 * Covers the reset/uninstall confirmation flow:
 *   - confirm-flow gating (cancel closes; reset confirm enabled immediately)
 *   - uninstall confirm disabled until the exact word "KEEPR" is typed
 *   - the chosen reason is threaded through to the service (exact call args)
 *   - failure path renders the error via notify.error (dev-build refusal verbatim)
 *   - success path shows the "Keepr is closing…" state
 *
 * Wrapped in StrictMode per repo convention (StrictMode is ON in main.tsx).
 * The renderer service is mocked (components never call window.api directly).
 */

import React, { StrictMode } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// --- Mocks -----------------------------------------------------------------

const mockReset = jest.fn();
const mockUninstall = jest.fn();
jest.mock("../../../services", () => ({
  appCleanupService: {
    reset: (...args: unknown[]) => mockReset(...args),
    uninstall: (...args: unknown[]) => mockUninstall(...args),
  },
}));

const mockContactSupport = jest.fn();
jest.mock("../../../services/systemService", () => ({
  systemService: {
    contactSupport: (...args: unknown[]) => mockContactSupport(...args),
  },
}));

const mockNotifyError = jest.fn();
const mockNotifySuccess = jest.fn();
jest.mock("@/hooks/useNotification", () => ({
  useNotification: () => ({
    notify: {
      error: (...args: unknown[]) => mockNotifyError(...args),
      success: (...args: unknown[]) => mockNotifySuccess(...args),
      warning: jest.fn(),
      info: jest.fn(),
    },
    dismiss: jest.fn(),
    dismissAll: jest.fn(),
  }),
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { TroubleshootingSettings } from "../TroubleshootingSettings";

const renderStrict = () =>
  render(
    <StrictMode>
      <TroubleshootingSettings />
    </StrictMode>,
  );

describe("TroubleshootingSettings (BACKLOG-2112)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReset.mockResolvedValue({ success: true, mode: "reset" });
    mockUninstall.mockResolvedValue({ success: true, mode: "uninstall" });
    mockContactSupport.mockResolvedValue({ success: true });
  });

  it("renders both danger action rows", () => {
    renderStrict();
    expect(screen.getByTestId("troubleshooting-reset-open")).toBeInTheDocument();
    expect(
      screen.getByTestId("troubleshooting-uninstall-open"),
    ).toBeInTheDocument();
  });

  it("opens the reset confirm modal and cancel closes it without calling the service", () => {
    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-reset-open"));
    expect(
      screen.getByTestId("troubleshooting-confirm-modal"),
    ).toBeInTheDocument();
    expect(screen.getByText("Reset app data?")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("troubleshooting-cancel"));
    expect(
      screen.queryByTestId("troubleshooting-confirm-modal"),
    ).not.toBeInTheDocument();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("reset confirm is enabled immediately (no type-to-confirm gate)", () => {
    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-reset-open"));
    expect(screen.getByTestId("troubleshooting-confirm")).not.toBeDisabled();
    // Reset has no KEEPR gate input.
    expect(
      screen.queryByTestId("troubleshooting-confirm-word"),
    ).not.toBeInTheDocument();
  });

  it("uninstall confirm is DISABLED until the exact word KEEPR is typed", () => {
    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-uninstall-open"));

    const confirmBtn = screen.getByTestId("troubleshooting-confirm");
    const wordInput = screen.getByTestId("troubleshooting-confirm-word");

    // Initially disabled.
    expect(confirmBtn).toBeDisabled();

    // Wrong / partial / lowercase does NOT enable.
    fireEvent.change(wordInput, { target: { value: "keepr" } });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(wordInput, { target: { value: "KEEP" } });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(wordInput, { target: { value: " KEEPR " } });
    expect(confirmBtn).toBeDisabled();

    // Exact match enables.
    fireEvent.change(wordInput, { target: { value: "KEEPR" } });
    expect(confirmBtn).not.toBeDisabled();
  });

  it("reset threads the selected reason through to the service (exact args)", async () => {
    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-reset-open"));
    fireEvent.change(screen.getByTestId("troubleshooting-reason-select"), {
      target: { value: "privacy" },
    });
    fireEvent.click(screen.getByTestId("troubleshooting-confirm"));

    await waitFor(() => expect(mockReset).toHaveBeenCalledTimes(1));
    expect(mockReset).toHaveBeenCalledWith("privacy");
  });

  it("reset with no reason chosen passes undefined", async () => {
    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-reset-open"));
    fireEvent.click(screen.getByTestId("troubleshooting-confirm"));

    await waitFor(() => expect(mockReset).toHaveBeenCalledTimes(1));
    expect(mockReset).toHaveBeenCalledWith(undefined);
  });

  it("'other' reason forwards the free-text value", async () => {
    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-reset-open"));
    fireEvent.change(screen.getByTestId("troubleshooting-reason-select"), {
      target: { value: "other" },
    });
    fireEvent.change(screen.getByTestId("troubleshooting-reason-other"), {
      target: { value: "app kept crashing" },
    });
    fireEvent.click(screen.getByTestId("troubleshooting-confirm"));

    await waitFor(() => expect(mockReset).toHaveBeenCalledTimes(1));
    expect(mockReset).toHaveBeenCalledWith("app kept crashing");
  });

  it("uninstall threads reason after the KEEPR gate is satisfied", async () => {
    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-uninstall-open"));
    fireEvent.change(screen.getByTestId("troubleshooting-reason-select"), {
      target: { value: "switching-device" },
    });
    fireEvent.change(screen.getByTestId("troubleshooting-confirm-word"), {
      target: { value: "KEEPR" },
    });
    fireEvent.click(screen.getByTestId("troubleshooting-confirm"));

    await waitFor(() => expect(mockUninstall).toHaveBeenCalledTimes(1));
    expect(mockUninstall).toHaveBeenCalledWith("switching-device");
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("failure path renders the error verbatim via notify.error", async () => {
    const devRefusal =
      "App cleanup is disabled in development builds to prevent wiping a dev environment.";
    mockReset.mockResolvedValue({
      success: false,
      mode: "reset",
      error: devRefusal,
    });

    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-reset-open"));
    fireEvent.click(screen.getByTestId("troubleshooting-confirm"));

    await waitFor(() => expect(mockNotifyError).toHaveBeenCalledTimes(1));
    expect(mockNotifyError.mock.calls[0][0]).toBe(devRefusal);
    // Modal closes on failure so the user can retry.
    await waitFor(() =>
      expect(
        screen.queryByTestId("troubleshooting-confirm-modal"),
      ).not.toBeInTheDocument(),
    );
  });

  it("failure toast exposes a Contact support action wired to systemService", async () => {
    mockUninstall.mockResolvedValue({
      success: false,
      mode: "uninstall",
      error: "boom",
    });

    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-uninstall-open"));
    fireEvent.change(screen.getByTestId("troubleshooting-confirm-word"), {
      target: { value: "KEEPR" },
    });
    fireEvent.click(screen.getByTestId("troubleshooting-confirm"));

    await waitFor(() => expect(mockNotifyError).toHaveBeenCalledTimes(1));
    const options = mockNotifyError.mock.calls[0][1] as {
      action?: { label: string; onClick: () => void };
    };
    expect(options.action?.label).toBe("Contact support");
    // Firing the action reaches systemService.contactSupport with the error text.
    options.action?.onClick();
    expect(mockContactSupport).toHaveBeenCalledWith("boom");
  });

  it("success path shows the 'Keepr is closing…' state", async () => {
    renderStrict();
    fireEvent.click(screen.getByTestId("troubleshooting-reset-open"));
    fireEvent.click(screen.getByTestId("troubleshooting-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("troubleshooting-closing")).toBeInTheDocument(),
    );
    expect(screen.getByText("Keepr is closing…")).toBeInTheDocument();
    expect(mockNotifyError).not.toHaveBeenCalled();
  });
});
