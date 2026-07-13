/**
 * Tests for IphoneSyncSettings.tsx
 *
 * BACKLOG-1937: the USB-detection toggle now accepts a `disabled` prop so it can
 * be grayed out inside the "iPhone Sync" Settings category when the import
 * source is not iPhone. When disabled, interaction is blocked but the persisted
 * value is NOT changed.
 *
 * Wrapped in React.StrictMode per repo convention (StrictMode is ON in prod).
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { IphoneSyncSettings } from "../IphoneSyncSettings";

// Mock the IPhoneSyncContext hook that backs the toggle.
const mockSetIphoneSyncEnabled = jest.fn().mockResolvedValue(undefined);
let mockEnabled = false;
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncEnabled: () => ({
    enabled: mockEnabled,
    setIphoneSyncEnabled: mockSetIphoneSyncEnabled,
  }),
}));

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

describe("IphoneSyncSettings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnabled = false;
  });

  it("renders the toggle and description", () => {
    renderStrict(<IphoneSyncSettings />);

    expect(screen.getByText("iPhone Sync (USB)")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /enable iphone sync over usb/i }),
    ).toBeInTheDocument();
  });

  it("toggles the persisted value when enabled (not disabled)", async () => {
    renderStrict(<IphoneSyncSettings />);

    const toggle = screen.getByRole("switch", {
      name: /enable iphone sync over usb/i,
    });
    expect(toggle).not.toBeDisabled();

    await userEvent.click(toggle);
    expect(mockSetIphoneSyncEnabled).toHaveBeenCalledWith(true);
  });

  it("disables the toggle when disabled prop is set", () => {
    renderStrict(<IphoneSyncSettings disabled />);

    const toggle = screen.getByRole("switch", {
      name: /enable iphone sync over usb/i,
    });
    expect(toggle).toBeDisabled();
  });

  it("does NOT change the persisted value when clicked while disabled", async () => {
    renderStrict(<IphoneSyncSettings disabled />);

    const toggle = screen.getByRole("switch", {
      name: /enable iphone sync over usb/i,
    });
    // Click a disabled button — the handler must not call the setter.
    await userEvent.click(toggle);
    expect(mockSetIphoneSyncEnabled).not.toHaveBeenCalled();
  });

  it("applies muted styling to the label when disabled", () => {
    renderStrict(<IphoneSyncSettings disabled />);

    expect(screen.getByText("iPhone Sync (USB)")).toHaveClass("text-gray-400");
  });

  it("preserves the aria-checked state while disabled (value not unset)", () => {
    mockEnabled = true;
    renderStrict(<IphoneSyncSettings disabled />);

    const toggle = screen.getByRole("switch", {
      name: /enable iphone sync over usb/i,
    });
    // Grayed out but the underlying enabled value is still reflected.
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});
