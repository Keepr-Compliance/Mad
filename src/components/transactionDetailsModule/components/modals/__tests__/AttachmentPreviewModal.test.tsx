/**
 * AttachmentPreviewModal Tests
 * Tests for email attachment preview with image, PDF, and DOCX display
 * TASK-1778: Email Attachment Preview Modal
 * TASK-1783: Add PDF and DOCX inline preview
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachmentPreviewModal } from "../AttachmentPreviewModal";

// Mock the window.api.transactions methods
const mockGetAttachmentData = jest.fn();
const mockGetAttachmentBuffer = jest.fn();

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).api = {
    transactions: {
      getAttachmentData: mockGetAttachmentData,
      getAttachmentBuffer: mockGetAttachmentBuffer,
    },
  };

  // Mock scrollTo for JSDOM (not implemented by default)
  Element.prototype.scrollTo = jest.fn();
});

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).api;
});

// Helper to create mock attachment data
function createMockAttachment(overrides: Partial<{
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}> = {}) {
  return {
    id: "att-1",
    filename: "document.pdf",
    mime_type: "application/pdf",
    file_size_bytes: 1024000,
    storage_path: "/path/to/document.pdf",
    ...overrides,
  };
}

describe("AttachmentPreviewModal", () => {
  const mockOnClose = jest.fn();
  const mockOnOpenWithSystem = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAttachmentData.mockResolvedValue({
      success: true,
      data: "data:image/jpeg;base64,abc123",
    });
    // Valid base64 string (just some bytes, mammoth mock will handle it)
    mockGetAttachmentBuffer.mockResolvedValue({
      success: true,
      data: "SGVsbG8gV29ybGQ=", // "Hello World" in base64
    });
  });

  describe("Basic Rendering", () => {
    it("should render attachment filename", async () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({ filename: "report.pdf" })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Wait for PDF to render (async)
      await waitFor(() => {
        expect(screen.getByTestId("pdf-preview")).toBeInTheDocument();
      });

      // Filename appears in header
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });

    it("should render formatted file size", async () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({ file_size_bytes: 1048576 })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Wait for render
      await waitFor(() => {
        expect(screen.getByTestId("pdf-preview")).toBeInTheDocument();
      });

      // 1048576 bytes = 1 MB - appears in header
      expect(screen.getByText("1 MB")).toBeInTheDocument();
    });

    it("should render file size in KB", async () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({ file_size_bytes: 2048 })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Wait for render
      await waitFor(() => {
        expect(screen.getByTestId("pdf-preview")).toBeInTheDocument();
      });

      // Size appears in header
      expect(screen.getByText("2 KB")).toBeInTheDocument();
    });

    it("should render 0 B for null file size", async () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({ file_size_bytes: null })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Wait for render
      await waitFor(() => {
        expect(screen.getByTestId("pdf-preview")).toBeInTheDocument();
      });

      // Size appears in header
      expect(screen.getByText("0 B")).toBeInTheDocument();
    });

    it("should have close button with aria-label", () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment()}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      expect(screen.getByRole("button", { name: "Close preview" })).toBeInTheDocument();
    });
  });

  describe("Image Attachments", () => {
    it("should render image preview for image attachments", async () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "photo.jpg",
            mime_type: "image/jpeg",
            storage_path: "/path/to/photo.jpg",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Wait for async image load
      await waitFor(() => {
        expect(screen.getByTestId("preview-image")).toBeInTheDocument();
      });

      const img = screen.getByTestId("preview-image");
      expect(img).toHaveAttribute("src", "data:image/jpeg;base64,abc123");
      expect(img).toHaveAttribute("alt", "photo.jpg");
    });

    it("should render image preview for PNG", async () => {
      mockGetAttachmentData.mockResolvedValue({
        success: true,
        data: "data:image/png;base64,xyz789",
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "screenshot.png",
            mime_type: "image/png",
            storage_path: "/path/to/screenshot.png",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("preview-image")).toBeInTheDocument();
      });

      const img = screen.getByTestId("preview-image");
      expect(img).toHaveAttribute("src", "data:image/png;base64,xyz789");
    });

    it("should show loading state while fetching image", async () => {
      // Create a promise that doesn't resolve immediately
      let resolvePromise: (value: { success: boolean; data: string }) => void;
      mockGetAttachmentData.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve;
        })
      );

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "loading.jpg",
            mime_type: "image/jpeg",
            storage_path: "/path/to/loading.jpg",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Should show loading state
      expect(screen.getByTestId("image-loading")).toBeInTheDocument();
      expect(screen.getByText("Loading preview...")).toBeInTheDocument();

      // Resolve the promise
      resolvePromise!({ success: true, data: "data:image/jpeg;base64,abc" });

      // Should show image after loading
      await waitFor(() => {
        expect(screen.getByTestId("preview-image")).toBeInTheDocument();
      });
    });

    it("should show error fallback when API returns error", async () => {
      mockGetAttachmentData.mockResolvedValue({
        success: false,
        error: "File not found",
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "broken.jpg",
            mime_type: "image/jpeg",
            storage_path: "/path/to/broken.jpg",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("image-error-fallback")).toBeInTheDocument();
      });
      expect(screen.getByText("Failed to load image")).toBeInTheDocument();
    });

    it("should show error fallback when image element fails to load", async () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "broken.jpg",
            mime_type: "image/jpeg",
            storage_path: "/path/to/broken.jpg",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("preview-image")).toBeInTheDocument();
      });

      const img = screen.getByTestId("preview-image");
      fireEvent.error(img);

      expect(screen.getByTestId("image-error-fallback")).toBeInTheDocument();
      expect(screen.getByText("Failed to load image")).toBeInTheDocument();
    });

    it("should show Open with System Viewer button on image error", async () => {
      mockGetAttachmentData.mockResolvedValue({
        success: false,
        error: "File not found",
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "broken.jpg",
            mime_type: "image/jpeg",
            storage_path: "/path/to/broken.jpg",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("image-error-fallback")).toBeInTheDocument();
      });
      expect(screen.getByText("Open with System Viewer")).toBeInTheDocument();
    });
  });

  describe("PDF Attachments (TASK-1783)", () => {
    it("should render PDF preview for PDF attachments", async () => {
      mockGetAttachmentData.mockResolvedValue({
        success: true,
        data: "data:application/pdf;base64,JVBERi0...",
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "document.pdf",
            mime_type: "application/pdf",
            storage_path: "/path/to/document.pdf",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("pdf-preview")).toBeInTheDocument();
      });

      // Should show the PDF document container
      expect(screen.getByTestId("pdf-document")).toBeInTheDocument();
    });

    it("should render PDF in scrollable view without pagination", async () => {
      mockGetAttachmentData.mockResolvedValue({
        success: true,
        data: "data:application/pdf;base64,JVBERi0...",
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "multipage.pdf",
            mime_type: "application/pdf",
            storage_path: "/path/to/multipage.pdf",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Wait for PDF preview to load
      await waitFor(() => {
        expect(screen.getByTestId("pdf-preview")).toBeInTheDocument();
      });

      // Full scroll view - no pagination buttons (all pages rendered for scrolling)
      expect(screen.queryByTestId("pdf-prev-page")).not.toBeInTheDocument();
      expect(screen.queryByTestId("pdf-next-page")).not.toBeInTheDocument();
    });

    it("should show error fallback when PDF load fails", async () => {
      mockGetAttachmentData.mockResolvedValue({
        success: false,
        error: "Failed to load PDF",
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "broken.pdf",
            mime_type: "application/pdf",
            storage_path: "/path/to/broken.pdf",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("pdf-error-fallback")).toBeInTheDocument();
      });

      expect(screen.getByText("Failed to load PDF")).toBeInTheDocument();
      expect(screen.getByText("Open with System Viewer")).toBeInTheDocument();
    });
  });

  describe("DOCX Attachments (TASK-1783)", () => {
    it("should render DOCX preview for Word documents", async () => {
      mockGetAttachmentBuffer.mockResolvedValue({
        success: true,
        data: "SGVsbG8gV29ybGQ=", // Valid base64 for mammoth mock
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "document.docx",
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            storage_path: "/path/to/document.docx",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("docx-preview")).toBeInTheDocument();
      });

      // Should contain the converted HTML content
      expect(screen.getByText("Mock DOCX content converted to HTML")).toBeInTheDocument();
    });

    it("should render DOCX preview for legacy .doc files", async () => {
      mockGetAttachmentBuffer.mockResolvedValue({
        success: true,
        data: "SGVsbG8gV29ybGQ=", // Valid base64 for mammoth mock
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "legacy.doc",
            mime_type: "application/msword",
            storage_path: "/path/to/legacy.doc",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("docx-preview")).toBeInTheDocument();
      });
    });

    it("should show error fallback when DOCX load fails", async () => {
      mockGetAttachmentBuffer.mockResolvedValue({
        success: false,
        error: "Failed to load DOCX",
      });

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "broken.docx",
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            storage_path: "/path/to/broken.docx",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId("docx-error-fallback")).toBeInTheDocument();
      });

      expect(screen.getByText("Failed to load DOCX")).toBeInTheDocument();
      expect(screen.getByText("Open with System Viewer")).toBeInTheDocument();
    });
  });

  describe("Non-Previewable Attachments", () => {
    it("should show fallback UI for Excel files", () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "spreadsheet.xlsx",
            mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      expect(screen.getByTestId("non-image-fallback")).toBeInTheDocument();
      expect(screen.getByText("Open with System Viewer")).toBeInTheDocument();
    });

    it("should show not downloaded message when storage_path is null for non-previewable", () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "missing.xlsx",
            mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            storage_path: null,
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      expect(screen.getByText("Attachment not downloaded")).toBeInTheDocument();
      expect(screen.queryByText("Open with System Viewer")).not.toBeInTheDocument();
    });
  });

  describe("Close Functionality", () => {
    it("should call onClose when close button is clicked", async () => {
      const user = userEvent.setup();

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment()}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await user.click(screen.getByRole("button", { name: "Close preview" }));
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("should call onClose when Escape key is pressed", () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment()}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      fireEvent.keyDown(window, { key: "Escape" });
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("should call onClose when backdrop is clicked", async () => {
      const user = userEvent.setup();

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment()}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      const backdrop = screen.getByTestId("attachment-preview-backdrop");
      await user.click(backdrop);
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("should NOT close when clicking inside the modal content", async () => {
      const user = userEvent.setup();

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment()}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Click on the filename text inside the modal
      const filename = screen.getAllByText("document.pdf")[0];
      await user.click(filename);
      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });

  describe("Open With System", () => {
    it("should call onOpenWithSystem when Open button is clicked", async () => {
      const user = userEvent.setup();

      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            storage_path: "/path/to/file.pdf",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      await user.click(screen.getByTestId("open-with-system-button"));
      expect(mockOnOpenWithSystem).toHaveBeenCalledWith("/path/to/file.pdf");
    });

    it.each([
      ["DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["PDF", "application/pdf"],
      ["image", "image/png"],
    ])("BACKLOG-3884: a %s with no storage_path says it is not downloaded instead of an empty body", (_label, mime) => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({ mime_type: mime, storage_path: null })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      expect(screen.getByTestId("non-image-fallback")).toBeInTheDocument();
      expect(screen.getByText("Attachment not downloaded")).toBeInTheDocument();
    });

    it("should NOT show Open button when storage_path is null", () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            // Non-previewable file type
            mime_type: "application/zip",
            storage_path: null,
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      expect(screen.queryByTestId("open-with-system-button")).not.toBeInTheDocument();
    });
  });

  describe("Edge Cases", () => {
    it("should handle null mime_type", () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            mime_type: null,
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Should show non-image fallback
      expect(screen.getByTestId("non-image-fallback")).toBeInTheDocument();
    });

    it("should handle empty filename", () => {
      render(
        <AttachmentPreviewModal
          attachment={createMockAttachment({
            filename: "",
            // Non-previewable file type
            mime_type: "application/zip",
          })}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      // Modal should still render
      expect(screen.getByTestId("non-image-fallback")).toBeInTheDocument();
    });

    it("should cleanup escape key listener on unmount", () => {
      const { unmount } = render(
        <AttachmentPreviewModal
          attachment={createMockAttachment()}
          onClose={mockOnClose}
          onOpenWithSystem={mockOnOpenWithSystem}
        />
      );

      unmount();

      // Should not call onClose after unmount
      fireEvent.keyDown(window, { key: "Escape" });
      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });
});
