/**
 * EmailViewModal Tests
 * Tests for HTML email rendering with sanitization and view toggling
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmailViewModal } from "../EmailViewModal";
import type { Communication } from "../../../types";

// Helper to create mock email data
function createMockEmail(overrides: Partial<Communication> = {}): Communication {
  return {
    id: "test-email-1",
    user_id: "user-1",
    channel: "email",
    direction: "inbound",
    subject: "Test Email Subject",
    sender: "sender@example.com",
    recipients: "recipient@example.com",
    body_html: "<p>This is <strong>HTML</strong> content.</p>",
    body_text: "This is plain text content.",
    body_plain: "This is plain text content (deprecated).",
    sent_at: "2024-01-15T10:00:00Z",
    has_attachments: false,
    is_false_positive: false,
    created_at: "2024-01-15T10:00:00Z",
    ...overrides,
  };
}

describe("EmailViewModal", () => {
  const mockOnClose = jest.fn();
  const mockOnRemoveFromTransaction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset window.api mock
    window.api.shell.openExternal = jest.fn().mockResolvedValue(undefined);
  });

  // BACKLOG-1762: resolve display names from Contacts when the header has no name
  describe("Contact name resolution (BACKLOG-1762)", () => {
    const nameMap: ReadonlyMap<string, string> = new Map([
      ["emily.patt@gmail.com", "Emily Patterson"],
    ]);

    it("renders the contact name on the From line when the header has no name", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ sender: "emily.patt@gmail.com" })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
          nameMap={nameMap}
        />
      );

      expect(
        screen.getByText("Emily Patterson <emily.patt@gmail.com>")
      ).toBeInTheDocument();
    });

    it("collapses the degenerate 'email <email>' From line and falls back to the address when no contact matches", () => {
      render(
        <EmailViewModal
          email={createMockEmail({
            sender: "sarah.mitchell@example.com <sarah.mitchell@example.com>",
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
          nameMap={nameMap}
        />
      );

      expect(screen.getByText("sarah.mitchell@example.com")).toBeInTheDocument();
    });

    it("keeps a genuine header name over the contact name (header truth first)", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ sender: "Emmy <emily.patt@gmail.com>" })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
          nameMap={nameMap}
        />
      );

      expect(screen.getByText("Emmy <emily.patt@gmail.com>")).toBeInTheDocument();
    });
  });

  describe("Basic Rendering", () => {
    it("should render email subject", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ subject: "Important Email" })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getAllByText("Important Email")[0]).toBeInTheDocument();
    });

    it("should render (No Subject) when subject is missing", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ subject: undefined })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getAllByText("(No Subject)")[0]).toBeInTheDocument();
    });

    it("should render sender information", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ sender: "john@example.com" })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getByText("john@example.com")).toBeInTheDocument();
    });

    it("should render Unknown when sender is missing", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ sender: undefined })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getByText("Unknown")).toBeInTheDocument();
    });

    it("should render recipients", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ recipients: "alice@example.com, bob@example.com" })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getByText("alice@example.com, bob@example.com")).toBeInTheDocument();
    });

    it("should render date", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ sent_at: "2024-06-15T14:30:00Z" })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // The exact format depends on locale, just check some part of the date is rendered
      expect(screen.getAllByText(/2024|Jun|15/)[0]).toBeInTheDocument();
    });

    it("should render Unknown date when sent_at is missing", () => {
      render(
        <EmailViewModal
          email={createMockEmail({ sent_at: undefined })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getByText("Unknown date")).toBeInTheDocument();
    });
  });

  describe("HTML Rendering", () => {
    it("should render HTML content by default when available", () => {
      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: "<p>Hello <strong>World</strong></p>",
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Check that HTML is rendered (the strong tag should be rendered)
      expect(screen.getByText("Hello")).toBeInTheDocument();
      expect(screen.getByText("World")).toBeInTheDocument();
    });

    it("should sanitize dangerous HTML content", () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<p onclick="alert(\'XSS\')">Click me</p><script>alert("XSS")</script>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Script tags should be removed
      expect(container.querySelector("script")).toBeNull();

      // onclick should be stripped
      const paragraph = screen.getByText("Click me");
      expect(paragraph).not.toHaveAttribute("onclick");
    });

    it("should remove onerror and onload attributes from HTML", () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<img src="test.jpg" onerror="alert(\'XSS\')" onload="alert(\'loaded\')" alt="test">',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      const img = container.querySelector("img");
      expect(img).toBeInTheDocument();
      expect(img).not.toHaveAttribute("onerror");
      expect(img).not.toHaveAttribute("onload");
    });

    it("should preserve allowed HTML tags", () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<div><p>Paragraph</p><ul><li>Item 1</li><li>Item 2</li></ul><a href="https://example.com">Link</a></div>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(container.querySelector("p")).toBeInTheDocument();
      expect(container.querySelector("ul")).toBeInTheDocument();
      expect(container.querySelectorAll("li")).toHaveLength(2);
      expect(container.querySelector("a")).toBeInTheDocument();
    });
  });

  describe("Plain Text Fallback", () => {
    it("should render plain text when no HTML is available", () => {
      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: undefined,
            body_text: "Plain text only email",
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getByText("Plain text only email")).toBeInTheDocument();
    });

    it("should fallback to body_plain when body_text is not available", () => {
      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: undefined,
            body_text: undefined,
            body_plain: "Legacy plain text",
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getByText("Legacy plain text")).toBeInTheDocument();
    });

    it("should show no content message when no content is available", () => {
      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: undefined,
            body_text: undefined,
            body_plain: undefined,
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getByText("No email content available")).toBeInTheDocument();
    });
  });

  describe("View Toggle", () => {
    it("should show toggle buttons when both HTML and plain text are available", () => {
      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: "<p>HTML content</p>",
            body_text: "Plain text content",
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.getByRole("button", { name: "Rich" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument();
    });

    it("should NOT show toggle when only HTML is available", () => {
      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: "<p>HTML only</p>",
            body_text: undefined,
            body_plain: undefined,
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.queryByRole("button", { name: "Rich" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Plain" })).not.toBeInTheDocument();
    });

    it("should NOT show toggle when only plain text is available", () => {
      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: undefined,
            body_text: "Plain text only",
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(screen.queryByRole("button", { name: "Rich" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Plain" })).not.toBeInTheDocument();
    });

    it("should switch between HTML and plain text views", async () => {
      const user = userEvent.setup();

      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: "<p>HTML content</p>",
            body_text: "Plain text content",
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Default should be HTML (Rich)
      expect(screen.getByText("HTML content")).toBeInTheDocument();

      // Switch to Plain
      await user.click(screen.getByRole("button", { name: "Plain" }));
      expect(screen.getByText("Plain text content")).toBeInTheDocument();

      // Switch back to Rich
      await user.click(screen.getByRole("button", { name: "Rich" }));
      expect(screen.getByText("HTML content")).toBeInTheDocument();
    });

    it("should have correct aria-pressed attributes", async () => {
      const user = userEvent.setup();

      render(
        <EmailViewModal
          email={createMockEmail({
            body_html: "<p>HTML</p>",
            body_text: "Plain",
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      const richButton = screen.getByRole("button", { name: "Rich" });
      const plainButton = screen.getByRole("button", { name: "Plain" });

      // Default: Rich is pressed
      expect(richButton).toHaveAttribute("aria-pressed", "true");
      expect(plainButton).toHaveAttribute("aria-pressed", "false");

      // Switch to Plain
      await user.click(plainButton);
      expect(richButton).toHaveAttribute("aria-pressed", "false");
      expect(plainButton).toHaveAttribute("aria-pressed", "true");
    });
  });

  describe("External Links", () => {
    it("should open external links via window.api.shell.openExternal", async () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<a href="https://example.com">External Link</a>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      const link = container.querySelector('a[href="https://example.com"]');
      expect(link).toBeInTheDocument();

      // Click the link
      fireEvent.click(link!);

      expect(window.api.shell.openExternal).toHaveBeenCalledWith("https://example.com");
    });

    it("should handle http links", async () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<a href="http://example.com">HTTP Link</a>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      const link = container.querySelector('a[href="http://example.com"]');
      fireEvent.click(link!);

      expect(window.api.shell.openExternal).toHaveBeenCalledWith("http://example.com");
    });

    it("should NOT open non-http/https links externally", async () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<a href="mailto:test@example.com">Email Link</a>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      const link = container.querySelector('a[href="mailto:test@example.com"]');
      fireEvent.click(link!);

      expect(window.api.shell.openExternal).not.toHaveBeenCalled();
    });

    it("should fallback to window.open when shell.openExternal is not available", async () => {
      // Remove shell.openExternal
      window.api.shell.openExternal = undefined as unknown as jest.Mock;
      const mockWindowOpen = jest.fn();
      window.open = mockWindowOpen;

      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<a href="https://example.com">External Link</a>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      const link = container.querySelector('a[href="https://example.com"]');
      fireEvent.click(link!);

      expect(mockWindowOpen).toHaveBeenCalledWith(
        "https://example.com",
        "_blank",
        "noopener,noreferrer"
      );
    });
  });

  describe("Modal Actions", () => {
    it("should call onClose when close button is clicked", async () => {
      const user = userEvent.setup();

      render(
        <EmailViewModal
          email={createMockEmail()}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      await user.click(screen.getAllByRole("button", { name: "Close email" })[0]);
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should call onClose when Close footer button is clicked", async () => {
      const user = userEvent.setup();

      render(
        <EmailViewModal
          email={createMockEmail()}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      await user.click(screen.getByRole("button", { name: "Close" }));
      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should call onRemoveFromTransaction when remove button is clicked", async () => {
      const user = userEvent.setup();

      render(
        <EmailViewModal
          email={createMockEmail()}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      await user.click(screen.getByRole("button", { name: /Remove from Transaction/i }));
      expect(mockOnRemoveFromTransaction).toHaveBeenCalled();
    });
  });

  describe("XSS Prevention", () => {
    it("should strip javascript: URLs from links", () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<a href="javascript:alert(\'XSS\')">Malicious Link</a>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // DOMPurify completely removes links with javascript: URLs
      // The anchor tag may be removed entirely or have href stripped
      const link = container.querySelector("a");
      if (link) {
        // If link exists, href should not contain javascript:
        const href = link.getAttribute("href") || "";
        expect(href).not.toContain("javascript:");
      }
      // Either way, the malicious link is neutralized - this is acceptable behavior
    });

    it("should strip style tags with potential XSS", () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<style>body { background: url("javascript:alert(\'XSS\')") }</style><p>Content</p>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Style tags should be stripped
      expect(container.querySelector("style")).toBeNull();
      // Content should still be visible
      expect(screen.getByText("Content")).toBeInTheDocument();
    });

    it("should strip iframe tags", () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<iframe src="https://evil.com"></iframe><p>Content</p>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      expect(container.querySelector("iframe")).toBeNull();
      expect(screen.getByText("Content")).toBeInTheDocument();
    });

    it("should render images with data: URLs but not execute scripts", () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<img src="data:image/png;base64,iVBORw0KGgo=" alt="safe image"><p>Content</p>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Images with valid data URLs are allowed (common in emails)
      // The important thing is that script tags and event handlers are stripped
      const img = container.querySelector("img");
      expect(img).toBeInTheDocument();
      // Content should be visible
      expect(screen.getByText("Content")).toBeInTheDocument();
    });

    it("should strip form tags to prevent phishing", () => {
      const { container } = render(
        <EmailViewModal
          email={createMockEmail({
            body_html: '<form action="https://evil.com/steal"><input type="text" name="password"></form><p>Content</p>',
          })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Form tags should be stripped
      expect(container.querySelector("form")).toBeNull();
      expect(container.querySelector("input")).toBeNull();
      // Content should still be visible
      expect(screen.getByText("Content")).toBeInTheDocument();
    });
  });

  describe("Attachment Preview Integration (TASK-1778)", () => {
    beforeEach(() => {
      // Mock the transactions API for attachment fetching
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.api.transactions as any).getEmailAttachments = jest.fn().mockResolvedValue({
        success: true,
        data: [
          {
            id: "att-1",
            filename: "document.pdf",
            mime_type: "application/pdf",
            file_size_bytes: 1024000,
            storage_path: "/path/to/document.pdf",
          },
          {
            id: "att-2",
            filename: "image.jpg",
            mime_type: "image/jpeg",
            file_size_bytes: 512000,
            storage_path: "/path/to/image.jpg",
          },
        ],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.api.transactions as any).openAttachment = jest.fn().mockResolvedValue({
        success: true,
      });
    });

    it("should open preview modal when clicking an attachment", async () => {
      const user = userEvent.setup();

      render(
        <EmailViewModal
          email={createMockEmail({ has_attachments: true })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Wait for attachments to load
      await screen.findByText(/attachment/i);

      // Expand the attachments section
      const expandButton = screen.getByRole("button", { name: /attachment/i });
      await user.click(expandButton);

      // Wait for attachment buttons to appear
      await screen.findByTestId("attachment-att-1");

      // Click on an attachment to open preview
      await user.click(screen.getByTestId("attachment-att-1"));

      // Preview modal should appear
      expect(screen.getByTestId("attachment-preview-backdrop")).toBeInTheDocument();
      expect(screen.getAllByText("document.pdf").length).toBeGreaterThan(0);
    });

    it("should close preview modal when close button is clicked", async () => {
      const user = userEvent.setup();

      render(
        <EmailViewModal
          email={createMockEmail({ has_attachments: true })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Wait for attachments to load and expand
      await screen.findByText(/attachment/i);
      const expandButton = screen.getByRole("button", { name: /attachment/i });
      await user.click(expandButton);

      // Open preview
      await screen.findByTestId("attachment-att-1");
      await user.click(screen.getByTestId("attachment-att-1"));

      // Close preview
      await user.click(screen.getByRole("button", { name: "Close preview" }));

      // Preview modal should be gone
      expect(screen.queryByTestId("attachment-preview-backdrop")).not.toBeInTheDocument();
    });

    it("should call openAttachment when Open button is clicked in preview", async () => {
      const user = userEvent.setup();

      render(
        <EmailViewModal
          email={createMockEmail({ has_attachments: true })}
          onClose={mockOnClose}
          onRemoveFromTransaction={mockOnRemoveFromTransaction}
        />
      );

      // Wait for attachments to load and expand
      await screen.findByText(/attachment/i);
      const expandButton = screen.getByRole("button", { name: /attachment/i });
      await user.click(expandButton);

      // Open preview for PDF
      await screen.findByTestId("attachment-att-1");
      await user.click(screen.getByTestId("attachment-att-1"));

      // Click Open with System Viewer
      await user.click(screen.getByText("Open with System Viewer"));

      // Should call the openAttachment handler
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window.api.transactions as any).openAttachment).toHaveBeenCalledWith(
        "/path/to/document.pdf"
      );
    });
  });
});
