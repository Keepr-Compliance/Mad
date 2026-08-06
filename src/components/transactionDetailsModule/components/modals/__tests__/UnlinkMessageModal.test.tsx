/**
 * UnlinkMessageModal Tests
 * Tests for the message unlink confirmation dialog
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { UnlinkMessageModal } from "../UnlinkMessageModal";

describe("UnlinkMessageModal", () => {
  const mockOnCancel = jest.fn();
  const mockOnUnlink = jest.fn();
  const defaultProps = {
    phoneNumber: "+1 (555) 555-0112",
    messageCount: 5,
    isUnlinking: false,
    onCancel: mockOnCancel,
    onUnlink: mockOnUnlink,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Basic Rendering", () => {
    it("should render modal with test id", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      expect(screen.getByTestId("unlink-message-modal")).toBeInTheDocument();
    });

    it("should render confirmation title", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      expect(
        screen.getByText("Remove Messages from Transaction?")
      ).toBeInTheDocument();
    });

    it("should render phone number", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      expect(screen.getByText("+1 (555) 555-0112")).toBeInTheDocument();
    });

    it("should render message count with plural form", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      expect(screen.getByText("5 messages")).toBeInTheDocument();
    });

    it("should render message count with singular form", () => {
      render(<UnlinkMessageModal {...defaultProps} messageCount={1} />);
      expect(screen.getByText("1 message")).toBeInTheDocument();
    });

    it("should render explanation text", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      expect(
        screen.getByText(/These messages will be removed from this transaction/)
      ).toBeInTheDocument();
    });

    it("should render re-attach note", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      expect(
        screen.getByText(/They can be re-attached later if needed/)
      ).toBeInTheDocument();
    });
  });

  describe("Button Actions", () => {
    it("should call onCancel when Cancel button is clicked", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      fireEvent.click(screen.getByTestId("unlink-cancel-button"));
      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it("should call onUnlink when Remove Messages button is clicked", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      fireEvent.click(screen.getByTestId("unlink-confirm-button"));
      expect(mockOnUnlink).toHaveBeenCalledTimes(1);
    });

    it("should have Cancel button text", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      expect(
        screen.getByTestId("unlink-cancel-button")
      ).toHaveTextContent("Cancel");
    });

    it("should have Remove Messages button text when not unlinking", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      expect(
        screen.getByTestId("unlink-confirm-button")
      ).toHaveTextContent("Remove Messages");
    });
  });

  describe("Loading State", () => {
    it("should show Removing... text when isUnlinking is true", () => {
      render(<UnlinkMessageModal {...defaultProps} isUnlinking={true} />);
      expect(
        screen.getByTestId("unlink-confirm-button")
      ).toHaveTextContent("Removing...");
    });

    it("should disable Cancel button when isUnlinking is true", () => {
      render(<UnlinkMessageModal {...defaultProps} isUnlinking={true} />);
      expect(screen.getByTestId("unlink-cancel-button")).toBeDisabled();
    });

    it("should disable confirm button when isUnlinking is true", () => {
      render(<UnlinkMessageModal {...defaultProps} isUnlinking={true} />);
      expect(screen.getByTestId("unlink-confirm-button")).toBeDisabled();
    });

    it("should enable buttons when isUnlinking is false", () => {
      render(<UnlinkMessageModal {...defaultProps} isUnlinking={false} />);
      expect(screen.getByTestId("unlink-cancel-button")).not.toBeDisabled();
      expect(screen.getByTestId("unlink-confirm-button")).not.toBeDisabled();
    });
  });

  describe("Accessibility", () => {
    it("should have proper button roles", () => {
      render(<UnlinkMessageModal {...defaultProps} />);
      const buttons = screen.getAllByRole("button");
      expect(buttons).toHaveLength(2);
    });

    it("should display warning icon", () => {
      const { container } = render(<UnlinkMessageModal {...defaultProps} />);
      // Check for SVG with orange styling
      const svg = container.querySelector("svg.text-orange-600");
      expect(svg).toBeInTheDocument();
    });
  });
});
