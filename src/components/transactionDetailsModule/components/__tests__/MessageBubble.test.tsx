/**
 * Tests for MessageBubble component
 * Verifies rendering of inbound/outbound messages with proper styling
 * and special message types (voice, location, attachment-only, system)
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MessageBubble } from "../MessageBubble";
import type { Communication } from "../../types";
import type { MessageType } from "@/types";

describe("MessageBubble", () => {
  // Base mock message for testing
  const createMockMessage = (overrides: Partial<Communication> = {}): Communication => ({
    id: "msg-1",
    user_id: "user-123",
    channel: "sms",
    direction: "inbound",
    body_text: "Hello, this is a test message",
    sent_at: "2024-01-16T14:30:00Z",
    has_attachments: false,
    is_false_positive: false,
    ...overrides,
  } as Communication);

  describe("rendering", () => {
    it("should render message content", () => {
      const message = createMockMessage({ body_text: "Test message content" });

      render(<MessageBubble message={message} />);

      expect(screen.getByText("Test message content")).toBeInTheDocument();
    });

    it("should render with data-testid", () => {
      const message = createMockMessage();

      render(<MessageBubble message={message} />);

      expect(screen.getByTestId("message-bubble")).toBeInTheDocument();
    });

    it("should include direction data attribute", () => {
      const message = createMockMessage({ direction: "inbound" });

      render(<MessageBubble message={message} />);

      expect(screen.getByTestId("message-bubble")).toHaveAttribute(
        "data-direction",
        "inbound"
      );
    });
  });

  describe("inbound messages", () => {
    it("should align to the left", () => {
      const message = createMockMessage({ direction: "inbound" });

      render(<MessageBubble message={message} />);

      const bubble = screen.getByTestId("message-bubble");
      expect(bubble).toHaveClass("items-start");
    });

    it("should have gray background styling", () => {
      const message = createMockMessage({ direction: "inbound" });

      const { container } = render(<MessageBubble message={message} />);

      const bubbleContent = container.querySelector(".bg-gray-200");
      expect(bubbleContent).toBeInTheDocument();
    });
  });

  describe("undefined direction (safe default)", () => {
    it("should align to the left when direction is undefined", () => {
      const message = createMockMessage({ direction: undefined });

      render(<MessageBubble message={message} />);

      const bubble = screen.getByTestId("message-bubble");
      expect(bubble).toHaveClass("items-start");
    });

    it("should have gray background when direction is undefined", () => {
      const message = createMockMessage({ direction: undefined });

      const { container } = render(<MessageBubble message={message} />);

      const bubbleContent = container.querySelector(".bg-gray-200");
      expect(bubbleContent).toBeInTheDocument();
    });
  });

  describe("outbound messages", () => {
    it("should align to the right", () => {
      const message = createMockMessage({ direction: "outbound" });

      render(<MessageBubble message={message} />);

      const bubble = screen.getByTestId("message-bubble");
      expect(bubble).toHaveClass("items-end");
    });

    it("should have blue background styling", () => {
      const message = createMockMessage({ direction: "outbound" });

      const { container } = render(<MessageBubble message={message} />);

      const bubbleContent = container.querySelector(".bg-blue-500");
      expect(bubbleContent).toBeInTheDocument();
    });

    it("should have white text", () => {
      const message = createMockMessage({ direction: "outbound" });

      const { container } = render(<MessageBubble message={message} />);

      const bubbleContent = container.querySelector(".text-white");
      expect(bubbleContent).toBeInTheDocument();
    });
  });

  describe("timestamp display", () => {
    it("should display formatted timestamp", () => {
      const message = createMockMessage({ sent_at: "2024-01-16T14:30:00Z" });

      render(<MessageBubble message={message} />);

      // Should show time (format depends on locale)
      expect(screen.getByTestId("message-timestamp")).toBeInTheDocument();
    });

    it("should use received_at as fallback for inbound", () => {
      const message = createMockMessage({
        direction: "inbound",
        sent_at: undefined,
        received_at: "2024-01-16T15:00:00Z",
      });

      render(<MessageBubble message={message} />);

      expect(screen.getByTestId("message-timestamp")).toBeInTheDocument();
    });

    it("should handle missing timestamps gracefully", () => {
      const message = createMockMessage({
        sent_at: undefined,
        received_at: undefined,
      });

      render(<MessageBubble message={message} />);

      // Should not show timestamp element when no timestamp
      expect(screen.queryByTestId("message-timestamp")).not.toBeInTheDocument();
    });
  });

  describe("body text fallbacks", () => {
    it("should use body_text as primary content", () => {
      const message = createMockMessage({
        body_text: "Primary text",
        body_plain: "Fallback text",
      });

      render(<MessageBubble message={message} />);

      expect(screen.getByText("Primary text")).toBeInTheDocument();
      expect(screen.queryByText("Fallback text")).not.toBeInTheDocument();
    });

    it("should use body_plain as fallback", () => {
      const message = createMockMessage({
        body_text: undefined,
        body_plain: "Fallback plain text",
      });

      render(<MessageBubble message={message} />);

      expect(screen.getByText("Fallback plain text")).toBeInTheDocument();
    });

    it("should use body as final fallback", () => {
      const message = createMockMessage({
        body_text: undefined,
        body_plain: undefined,
        body: "Legacy body content",
      });

      render(<MessageBubble message={message} />);

      expect(screen.getByText("Legacy body content")).toBeInTheDocument();
    });

    it("should handle empty body gracefully", () => {
      const message = createMockMessage({
        body_text: undefined,
        body_plain: undefined,
        body: undefined,
      });

      render(<MessageBubble message={message} />);

      // Should render without error
      expect(screen.getByTestId("message-bubble")).toBeInTheDocument();
    });
  });

  describe("text formatting", () => {
    it("should preserve whitespace in messages", () => {
      const message = createMockMessage({
        body_text: "Line 1\nLine 2\nLine 3",
      });

      const { container } = render(<MessageBubble message={message} />);

      const textElement = container.querySelector(".whitespace-pre-wrap");
      expect(textElement).toBeInTheDocument();
    });

    it("should handle long messages with word break", () => {
      const longWord = "A".repeat(100);
      const message = createMockMessage({ body_text: longWord });

      const { container } = render(<MessageBubble message={message} />);

      const textElement = container.querySelector(".break-words");
      expect(textElement).toBeInTheDocument();
    });
  });

  describe("sender name display (group chats)", () => {
    it("should show sender name for inbound messages when provided", () => {
      const message = createMockMessage({ direction: "inbound" });

      render(<MessageBubble message={message} senderName="John Doe" showSender />);

      expect(screen.getByTestId("message-sender")).toHaveTextContent("John Doe");
    });

    it("should hide sender name when showSender is false", () => {
      const message = createMockMessage({ direction: "inbound" });

      render(<MessageBubble message={message} senderName="John Doe" showSender={false} />);

      expect(screen.queryByTestId("message-sender")).not.toBeInTheDocument();
    });

    it("should not show sender name for outbound messages", () => {
      const message = createMockMessage({ direction: "outbound" });

      render(<MessageBubble message={message} senderName="John Doe" showSender />);

      expect(screen.queryByTestId("message-sender")).not.toBeInTheDocument();
    });

    it("should not show sender name when senderName is undefined", () => {
      const message = createMockMessage({ direction: "inbound" });

      render(<MessageBubble message={message} showSender />);

      expect(screen.queryByTestId("message-sender")).not.toBeInTheDocument();
    });

    it("should show sender name by default when senderName is provided for inbound", () => {
      const message = createMockMessage({ direction: "inbound" });

      render(<MessageBubble message={message} senderName="Jane Smith" />);

      expect(screen.getByTestId("message-sender")).toHaveTextContent("Jane Smith");
    });

    it("should display sender name with timestamp separator", () => {
      const message = createMockMessage({
        direction: "inbound",
        sent_at: "2024-01-16T14:30:00Z",
      });

      render(<MessageBubble message={message} senderName="Alice" showSender />);

      const timestampElement = screen.getByTestId("message-timestamp");
      expect(timestampElement).toBeInTheDocument();
      // Sender should be present
      expect(screen.getByTestId("message-sender")).toHaveTextContent("Alice");
    });
  });

  describe("message type data attribute", () => {
    it("should include message-type data attribute", () => {
      const message = createMockMessage({ message_type: "text" as MessageType });

      render(<MessageBubble message={message} />);

      expect(screen.getByTestId("message-bubble")).toHaveAttribute(
        "data-message-type",
        "text"
      );
    });

    it("should default to text when message_type is undefined", () => {
      const message = createMockMessage({ message_type: undefined });

      render(<MessageBubble message={message} />);

      expect(screen.getByTestId("message-bubble")).toHaveAttribute(
        "data-message-type",
        "text"
      );
    });
  });

  describe("voice message type", () => {
    it("should display Voice Message indicator with transcript", () => {
      const message = createMockMessage({
        message_type: "voice_message" as MessageType,
        body_text: "This is the voice transcript",
      });

      render(<MessageBubble message={message} />);

      // Should show indicator
      expect(screen.getByTestId("message-type-indicator")).toBeInTheDocument();
      expect(screen.getByText("Voice Message")).toBeInTheDocument();
      // Should show transcript
      expect(screen.getByText("This is the voice transcript")).toBeInTheDocument();
    });

    it("should display fallback when no transcript available", () => {
      const message = createMockMessage({
        message_type: "voice_message" as MessageType,
        body_text: undefined,
        body_plain: undefined,
        body: undefined,
      });

      render(<MessageBubble message={message} />);

      expect(screen.getByText("Voice Message")).toBeInTheDocument();
      expect(screen.getByText("[No transcript available]")).toBeInTheDocument();
    });

    it("should include microphone icon", () => {
      const message = createMockMessage({
        message_type: "voice_message" as MessageType,
        body_text: "Transcript text",
      });

      render(<MessageBubble message={message} />);

      // Lucide icons render as SVG
      const indicator = screen.getByTestId("message-type-indicator");
      const svg = indicator.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });

    it("should work with outbound voice messages", () => {
      const message = createMockMessage({
        direction: "outbound",
        message_type: "voice_message" as MessageType,
        body_text: "Outbound voice transcript",
      });

      render(<MessageBubble message={message} />);

      const bubble = screen.getByTestId("message-bubble");
      expect(bubble).toHaveClass("items-end");
      expect(screen.getByText("Voice Message")).toBeInTheDocument();
    });
  });

  describe("location message type", () => {
    it("should display Location Shared indicator", () => {
      const message = createMockMessage({
        message_type: "location" as MessageType,
        body_text: "123 Main Street, City, ST 12345",
      });

      render(<MessageBubble message={message} />);

      expect(screen.getByTestId("message-type-indicator")).toBeInTheDocument();
      expect(screen.getByText("Location Shared")).toBeInTheDocument();
      expect(screen.getByText("123 Main Street, City, ST 12345")).toBeInTheDocument();
    });

    it("should display fallback when no location text", () => {
      const message = createMockMessage({
        message_type: "location" as MessageType,
        body_text: undefined,
      });

      render(<MessageBubble message={message} />);

      expect(screen.getByText("Location Shared")).toBeInTheDocument();
      expect(screen.getByText("Location information")).toBeInTheDocument();
    });

    it("should include map pin icon", () => {
      const message = createMockMessage({
        message_type: "location" as MessageType,
        body_text: "Location text",
      });

      render(<MessageBubble message={message} />);

      const indicator = screen.getByTestId("message-type-indicator");
      const svg = indicator.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });
  });

  describe("attachment-only message type", () => {
    it("should display Media Attachment indicator", () => {
      const message = createMockMessage({
        message_type: "attachment_only" as MessageType,
        has_attachments: true,
        body_text: undefined,
      });

      render(<MessageBubble message={message} />);

      expect(screen.getByTestId("message-type-indicator")).toBeInTheDocument();
      expect(screen.getByText("Media Attachment")).toBeInTheDocument();
      expect(screen.getByText("Attachment")).toBeInTheDocument();
    });

    it("should include paperclip icon", () => {
      const message = createMockMessage({
        message_type: "attachment_only" as MessageType,
        has_attachments: true,
      });

      render(<MessageBubble message={message} />);

      const indicator = screen.getByTestId("message-type-indicator");
      const svg = indicator.querySelector("svg");
      expect(svg).toBeInTheDocument();
    });

    it("should have italic styling for attachment text", () => {
      const message = createMockMessage({
        message_type: "attachment_only" as MessageType,
        has_attachments: true,
      });

      const { container } = render(<MessageBubble message={message} />);

      const textElement = container.querySelector(".italic");
      expect(textElement).toBeInTheDocument();
    });
  });

  describe("system message type", () => {
    it("should display centered with muted styling", () => {
      const message = createMockMessage({
        message_type: "system" as MessageType,
        body_text: "John joined the conversation",
      });

      render(<MessageBubble message={message} />);

      const bubble = screen.getByTestId("message-bubble");
      expect(bubble).toHaveClass("items-center");
      expect(screen.getByText("John joined the conversation")).toBeInTheDocument();
    });

    it("should have italic and gray text", () => {
      const message = createMockMessage({
        message_type: "system" as MessageType,
        body_text: "System notification",
      });

      const { container } = render(<MessageBubble message={message} />);

      const textElement = container.querySelector(".italic.text-gray-500");
      expect(textElement).toBeInTheDocument();
    });

    it("should not display regular bubble styling", () => {
      const message = createMockMessage({
        message_type: "system" as MessageType,
        body_text: "System message",
      });

      const { container } = render(<MessageBubble message={message} />);

      // Should not have the normal blue/gray bubble backgrounds
      expect(container.querySelector(".bg-blue-500")).not.toBeInTheDocument();
      expect(container.querySelector(".bg-gray-200")).not.toBeInTheDocument();
    });

    it("should have accessible role and aria-label", () => {
      const message = createMockMessage({
        message_type: "system" as MessageType,
        body_text: "System notification",
      });

      render(<MessageBubble message={message} />);

      const systemMessage = screen.getByRole("status");
      expect(systemMessage).toHaveAttribute("aria-label", "System message");
    });

    it("should not show indicator (no icon/label)", () => {
      const message = createMockMessage({
        message_type: "system" as MessageType,
        body_text: "System message",
      });

      render(<MessageBubble message={message} />);

      expect(screen.queryByTestId("message-type-indicator")).not.toBeInTheDocument();
    });
  });

  describe("default text message type", () => {
    it("should not show indicator for text messages", () => {
      const message = createMockMessage({
        message_type: "text" as MessageType,
        body_text: "Regular text message",
      });

      render(<MessageBubble message={message} />);

      expect(screen.queryByTestId("message-type-indicator")).not.toBeInTheDocument();
      expect(screen.getByText("Regular text message")).toBeInTheDocument();
    });

    it("should not show indicator for unknown message type", () => {
      const message = createMockMessage({
        message_type: "unknown" as MessageType,
        body_text: "Unknown type message",
      });

      render(<MessageBubble message={message} />);

      expect(screen.queryByTestId("message-type-indicator")).not.toBeInTheDocument();
      expect(screen.getByText("Unknown type message")).toBeInTheDocument();
    });

    it("should preserve existing behavior for messages without message_type", () => {
      const message = createMockMessage({
        body_text: "Regular message",
      });
      // Explicitly remove message_type to test backward compatibility
      // Message declares required fields, so it is not directly comparable to an
      // index-signature type; the extra hop is type-only (delete is unchanged).
      delete (message as unknown as Record<string, unknown>).message_type;

      render(<MessageBubble message={message} />);

      expect(screen.queryByTestId("message-type-indicator")).not.toBeInTheDocument();
      expect(screen.getByText("Regular message")).toBeInTheDocument();
    });
  });

  describe("audio player for voice messages", () => {
    it("should render audio player when attachmentPath is provided for voice message", () => {
      const message = createMockMessage({
        message_type: "voice_message" as MessageType,
        body_text: "Voice transcript",
        has_attachments: true,
      });

      render(
        <MessageBubble
          message={message}
          attachmentPath="/path/to/voice.m4a"
        />
      );

      expect(screen.getByTestId("audio-player")).toBeInTheDocument();
    });

    it("should not render audio player when attachmentPath is not provided", () => {
      const message = createMockMessage({
        message_type: "voice_message" as MessageType,
        body_text: "Voice transcript",
        has_attachments: true,
      });

      render(<MessageBubble message={message} />);

      expect(screen.queryByTestId("audio-player")).not.toBeInTheDocument();
    });

    it("should not render audio player for non-voice messages", () => {
      const message = createMockMessage({
        message_type: "text" as MessageType,
        body_text: "Regular text",
      });

      render(
        <MessageBubble
          message={message}
          attachmentPath="/path/to/file.pdf"
        />
      );

      expect(screen.queryByTestId("audio-player")).not.toBeInTheDocument();
    });

    it("should not render audio player for attachment_only messages", () => {
      const message = createMockMessage({
        message_type: "attachment_only" as MessageType,
        has_attachments: true,
      });

      render(
        <MessageBubble
          message={message}
          attachmentPath="/path/to/image.jpg"
        />
      );

      expect(screen.queryByTestId("audio-player")).not.toBeInTheDocument();
    });

    it("should render audio player with correct path for Windows paths", () => {
      const message = createMockMessage({
        message_type: "voice_message" as MessageType,
        body_text: "Windows voice message",
        has_attachments: true,
      });

      render(
        <MessageBubble
          message={message}
          attachmentPath="C:\\Users\\Test\\audio.m4a"
        />
      );

      expect(screen.getByTestId("audio-player")).toBeInTheDocument();
    });

    it("should show both transcript and audio player for voice messages", () => {
      const message = createMockMessage({
        message_type: "voice_message" as MessageType,
        body_text: "This is the transcript",
        has_attachments: true,
      });

      render(
        <MessageBubble
          message={message}
          attachmentPath="/path/to/voice.m4a"
        />
      );

      // Should show both transcript and audio player
      expect(screen.getByText("This is the transcript")).toBeInTheDocument();
      expect(screen.getByTestId("audio-player")).toBeInTheDocument();
      expect(screen.getByText("Voice Message")).toBeInTheDocument();
    });

    it("should render audio player for outbound voice messages", () => {
      const message = createMockMessage({
        direction: "outbound",
        message_type: "voice_message" as MessageType,
        body_text: "Outbound voice",
        has_attachments: true,
      });

      render(
        <MessageBubble
          message={message}
          attachmentPath="/path/to/voice.m4a"
        />
      );

      expect(screen.getByTestId("audio-player")).toBeInTheDocument();
      const bubble = screen.getByTestId("message-bubble");
      expect(bubble).toHaveClass("items-end");
    });
  });
});
