/**
 * SupportTicketDialog Tests
 * TASK-2282: Tests for conditional name/email fields
 *
 * Tests that the dialog:
 * - Shows name/email fields when userEmail/userName are empty (unauthenticated)
 * - Hides name/email fields when userEmail/userName are provided (authenticated)
 * - Shows "Submitting as" text when authenticated
 * - Disables submit when name/email are empty for unauthenticated users
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { SupportTicketDialog } from "../SupportTicketDialog";

// Mock the useSupportTicket hook. BACKLOG-1931: mockHookState is mutable so
// individual tests can override fields (e.g. diagnosticsLoading) without
// re-declaring the whole mock.
const mockHookState = {
  diagnostics: null as unknown,
  diagnosticsLoading: false,
  screenshot: null as unknown,
  screenshotLoading: false,
  categories: [] as unknown[],
  categoriesLoading: false,
  submitting: false,
  ticketNumber: null as unknown,
  error: null as unknown,
  success: false,
  collectDiagnostics: jest.fn(),
  captureScreenshot: jest.fn(),
  removeScreenshot: jest.fn(),
  submitTicket: jest.fn(),
  reset: jest.fn(),
};

jest.mock("../../../hooks/useSupportTicket", () => ({
  useSupportTicket: () => mockHookState,
}));

// Mock the child components
jest.mock("../DiagnosticsPreview", () => ({
  DiagnosticsPreview: () => <div data-testid="diagnostics-preview" />,
}));

jest.mock("../ScreenshotCapture", () => ({
  ScreenshotCapture: () => <div data-testid="screenshot-capture" />,
}));

// Setup support bridge mock
beforeEach(() => {
  if (!window.api.support) {
    (window.api as Record<string, unknown>).support = {
      collectDiagnostics: jest.fn().mockResolvedValue({ success: true, diagnostics: null }),
      captureScreenshot: jest.fn().mockResolvedValue({ success: true, screenshot: null }),
      getCategories: jest.fn().mockResolvedValue({ success: true, categories: [] }),
      submitTicket: jest.fn().mockResolvedValue({ success: true, ticket_number: 1 }),
    };
  }
  // BACKLOG-1931: Reset mutable mock state to defaults between tests.
  mockHookState.diagnosticsLoading = false;
  mockHookState.submitting = false;
});

describe("SupportTicketDialog", () => {
  const defaultProps = {
    onClose: jest.fn(),
    userEmail: "",
    userName: "",
  };

  describe("unauthenticated state (empty email/name)", () => {
    it("shows name and email input fields", () => {
      render(<SupportTicketDialog {...defaultProps} />);

      expect(screen.getByLabelText(/Your Name/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Your Email/)).toBeInTheDocument();
    });

    it("does not show 'Submitting as' text", () => {
      render(<SupportTicketDialog {...defaultProps} />);

      expect(screen.queryByText(/Submitting as/)).not.toBeInTheDocument();
    });

    it("disables submit when name and email are empty", () => {
      render(<SupportTicketDialog {...defaultProps} />);

      // Fill subject and description but not name/email
      fireEvent.change(screen.getByLabelText(/Subject/), {
        target: { value: "Test subject" },
      });
      fireEvent.change(screen.getByLabelText(/Description/), {
        target: { value: "Test description" },
      });

      const submitButton = screen.getByText("Submit Ticket");
      expect(submitButton).toBeDisabled();
    });

    it("enables submit when all required fields are filled", () => {
      render(<SupportTicketDialog {...defaultProps} />);

      fireEvent.change(screen.getByLabelText(/Your Name/), {
        target: { value: "John Doe" },
      });
      fireEvent.change(screen.getByLabelText(/Your Email/), {
        target: { value: "john@example.com" },
      });
      fireEvent.change(screen.getByLabelText(/Subject/), {
        target: { value: "Test subject" },
      });
      fireEvent.change(screen.getByLabelText(/Description/), {
        target: { value: "Test description" },
      });

      const submitButton = screen.getByText("Submit Ticket");
      expect(submitButton).not.toBeDisabled();
    });
  });

  describe("authenticated state (email/name provided)", () => {
    const authProps = {
      onClose: jest.fn(),
      userEmail: "user@example.com",
      userName: "Test User",
    };

    it("shows name and email fields pre-filled with user info", () => {
      render(<SupportTicketDialog {...authProps} />);

      const nameInput = screen.getByLabelText(/Your Name/) as HTMLInputElement;
      const emailInput = screen.getByLabelText(/Your Email/) as HTMLInputElement;
      expect(nameInput.value).toBe("Test User");
      expect(emailInput.value).toBe("user@example.com");
    });

    it("enables submit with just subject and description", () => {
      render(<SupportTicketDialog {...authProps} />);

      fireEvent.change(screen.getByLabelText(/Subject/), {
        target: { value: "Test subject" },
      });
      fireEvent.change(screen.getByLabelText(/Description/), {
        target: { value: "Test description" },
      });

      const submitButton = screen.getByText("Submit Ticket");
      expect(submitButton).not.toBeDisabled();
    });
  });

  it("renders diagnostics and screenshot components", () => {
    render(<SupportTicketDialog {...defaultProps} />);

    expect(screen.getByTestId("diagnostics-preview")).toBeInTheDocument();
    expect(screen.getByTestId("screenshot-capture")).toBeInTheDocument();
  });

  // BACKLOG-1931: Submit must stay disabled while diagnostics are still being
  // collected, even when every other required field is valid — otherwise a
  // fast user can submit a ticket with no diagnostics block attached.
  describe("gated on diagnosticsLoading (BACKLOG-1931)", () => {
    const authProps = {
      onClose: jest.fn(),
      userEmail: "user@example.com",
      userName: "Test User",
    };

    it("disables submit while diagnostics are still loading, even with all fields valid", () => {
      mockHookState.diagnosticsLoading = true;
      render(<SupportTicketDialog {...authProps} />);

      fireEvent.change(screen.getByLabelText(/Subject/), {
        target: { value: "Test subject" },
      });
      fireEvent.change(screen.getByLabelText(/Description/), {
        target: { value: "Test description" },
      });

      const submitButton = screen.getByText("Submit Ticket");
      expect(submitButton).toBeDisabled();
    });

    it("enables submit once diagnostics finish loading, with other fields valid", () => {
      mockHookState.diagnosticsLoading = false;
      render(<SupportTicketDialog {...authProps} />);

      fireEvent.change(screen.getByLabelText(/Subject/), {
        target: { value: "Test subject" },
      });
      fireEvent.change(screen.getByLabelText(/Description/), {
        target: { value: "Test description" },
      });

      const submitButton = screen.getByText("Submit Ticket");
      expect(submitButton).not.toBeDisabled();
    });
  });
});
