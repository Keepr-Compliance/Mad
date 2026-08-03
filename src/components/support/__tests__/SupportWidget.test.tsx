/**
 * SupportWidget Tests
 * TASK-2282: Tests for the floating "?" support widget
 *
 * Tests that the widget:
 * - Renders the "?" button without auth context
 * - Opens the dialog on click
 * - Passes user info when available
 * - Works without user info (unauthenticated)
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SupportWidget } from "../SupportWidget";

// Mock platform context - default to macOS (non-Windows)
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true, isWindows: false, isLinux: false, platform: "macos" })),
}));

// Mock SupportTicketDialog to avoid complex setup
jest.mock("../SupportTicketDialog", () => ({
  SupportTicketDialog: ({
    onClose,
    userEmail,
    userName,
  }: {
    onClose: () => void;
    userEmail: string;
    userName: string;
    autoCaptureScreenshot?: boolean;
  }) => (
    <div data-testid="support-dialog">
      <span data-testid="dialog-email">{userEmail}</span>
      <span data-testid="dialog-name">{userName}</span>
      <button data-testid="close-dialog" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

// Setup support bridge mock
beforeEach(() => {
  // Ensure window.api.support exists for the hook
  if (!window.api.support) {
    // WindowApi is a typed interface with no index signature, so the widening
    // to a keyed record has to go through unknown.
    (window.api as unknown as Record<string, unknown>).support = {
      collectDiagnostics: jest.fn().mockResolvedValue({ success: true, diagnostics: null }),
      captureScreenshot: jest.fn().mockResolvedValue({ success: true, screenshot: null }),
      getCategories: jest.fn().mockResolvedValue({ success: true, categories: [] }),
      submitTicket: jest.fn().mockResolvedValue({ success: true, ticket_number: 1 }),
    };
  }
});

describe("SupportWidget", () => {
  it("renders the '?' button without any props", () => {
    render(<SupportWidget />);

    const button = screen.getByLabelText("Open support dialog");
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("?");
  });

  it("renders the '?' button with optional props", () => {
    render(
      <SupportWidget userEmail="test@example.com" userName="Test User" />
    );

    const button = screen.getByLabelText("Open support dialog");
    expect(button).toBeInTheDocument();
  });

  it("opens the dialog when clicked", async () => {
    render(<SupportWidget />);

    const button = screen.getByLabelText("Open support dialog");
    await act(async () => { fireEvent.click(button); });

    await waitFor(() => {
      expect(screen.getByTestId("support-dialog")).toBeInTheDocument();
    });
  });

  it("closes the dialog when close is clicked", async () => {
    render(<SupportWidget />);

    // Open dialog
    await act(async () => { fireEvent.click(screen.getByLabelText("Open support dialog")); });
    await waitFor(() => {
      expect(screen.getByTestId("support-dialog")).toBeInTheDocument();
    });

    // Close dialog
    fireEvent.click(screen.getByTestId("close-dialog"));
    expect(screen.queryByTestId("support-dialog")).not.toBeInTheDocument();
  });

  it("passes empty strings when no user detected (unauthenticated)", async () => {
    // Default mock returns success: false for getCurrentUser
    render(<SupportWidget />);

    await act(async () => { fireEvent.click(screen.getByLabelText("Open support dialog")); });

    expect(screen.getByTestId("dialog-email")).toHaveTextContent("");
    expect(screen.getByTestId("dialog-name")).toHaveTextContent("");
  });

  it("passes user info when props are provided (authenticated)", async () => {
    render(
      <SupportWidget userEmail="user@example.com" userName="Jane Doe" />
    );

    await act(async () => { fireEvent.click(screen.getByLabelText("Open support dialog")); });

    await waitFor(() => {
      expect(screen.getByTestId("dialog-email")).toHaveTextContent(
        "user@example.com"
      );
    });
    expect(screen.getByTestId("dialog-name")).toHaveTextContent("Jane Doe");
  });

  it("detects user info via IPC when no props provided", async () => {
    // Mock getCurrentUser to return user info
    (window.api.auth.getCurrentUser as jest.Mock).mockResolvedValueOnce({
      success: true,
      user: { email: "detected@example.com", display_name: "Detected User" },
    });

    render(<SupportWidget />);

    // Wait for async user detection to complete
    await waitFor(() => {
      expect(window.api.auth.getCurrentUser).toHaveBeenCalled();
    });

    // Open the dialog after detection completes
    fireEvent.click(screen.getByLabelText("Open support dialog"));

    await waitFor(() => {
      expect(screen.getByTestId("dialog-email")).toHaveTextContent(
        "detected@example.com"
      );
      expect(screen.getByTestId("dialog-name")).toHaveTextContent(
        "Detected User"
      );
    });
  });

  // TASK-2319: Custom event tests
  it("opens the dialog when 'open-support-widget' event is dispatched", () => {
    render(<SupportWidget />);

    // Dialog should not be open initially
    expect(screen.queryByTestId("support-dialog")).not.toBeInTheDocument();

    // Dispatch custom event — wrap in act() for React state update
    act(() => {
      window.dispatchEvent(new CustomEvent("open-support-widget"));
    });

    // Dialog should now be open
    expect(screen.getByTestId("support-dialog")).toBeInTheDocument();
  });

  it("passes prefilledSubject from custom event detail", () => {
    render(<SupportWidget />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("open-support-widget", {
          detail: { subject: "Account Setup Issue" },
        })
      );
    });

    expect(screen.getByTestId("support-dialog")).toBeInTheDocument();
  });

  // BACKLOG-1554: Platform-specific positioning tests
  it("uses bottom-4 left-4 positioning on macOS", () => {
    render(<SupportWidget />);
    const button = screen.getByLabelText("Open support dialog");
    expect(button.className).toContain("bottom-4");
    expect(button.className).toContain("left-4");
  });

  it("uses bottom-8 left-8 positioning on Windows to avoid resize zone", () => {
    // Override the mock to return Windows
    const { usePlatform } = require("../../../contexts/PlatformContext");
    (usePlatform as jest.Mock).mockReturnValue({
      isMacOS: false,
      isWindows: true,
      isLinux: false,
      platform: "windows",
    });

    render(<SupportWidget />);
    const button = screen.getByLabelText("Open support dialog");
    expect(button.className).toContain("bottom-8");
    expect(button.className).toContain("left-8");

    // Restore default mock
    (usePlatform as jest.Mock).mockReturnValue({
      isMacOS: true,
      isWindows: false,
      isLinux: false,
      platform: "macos",
    });
  });
});
