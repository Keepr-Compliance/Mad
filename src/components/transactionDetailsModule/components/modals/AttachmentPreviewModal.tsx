/**
 * AttachmentPreviewModal Component
 * Preview modal for email attachments with image, PDF, and DOCX display
 * TASK-1778: Email Attachment Preview Modal
 * TASK-1783: Add PDF and DOCX inline preview
 */
import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  X,
  ExternalLink,
  Image,
  FileText,
  File,
} from "lucide-react";
import { ResponsiveModal, MODAL_PANEL } from "../../../common/ResponsiveModal";
import { Document, Page, pdfjs } from "react-pdf";
import DOMPurify from "dompurify";
// BACKLOG-1126: mammoth is lazy-loaded at point of use to reduce initial bundle size
import { formatFileSize } from "../../../../utils/formatUtils";

// Import react-pdf styles for annotations and text layer
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Configure PDF.js worker - use local copy in public folder to avoid CSP issues
// The worker file is copied from node_modules/pdfjs-dist/build/pdf.worker.min.mjs
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface AttachmentPreviewModalProps {
  attachment: {
    id: string;
    filename: string;
    mime_type: string | null;
    file_size_bytes: number | null;
    storage_path: string | null;
  };
  onClose: () => void;
  onOpenWithSystem: (storagePath: string) => void;
}

/**
 * Get appropriate icon for file type
 */
function getFileIcon(
  mimeType: string | null
): React.ComponentType<{ className?: string }> {
  if (mimeType?.startsWith("image/")) return Image;
  if (mimeType === "application/pdf") return FileText;
  return File;
}

/**
 * Check if a MIME type is a DOCX file
 */
function isDocxMimeType(mimeType: string | null): boolean {
  return (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  );
}

export function AttachmentPreviewModal({
  attachment,
  onClose,
  onOpenWithSystem,
}: AttachmentPreviewModalProps): React.ReactElement {
  // Image preview state
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);

  // PDF preview state
  const [pdfData, setPdfData] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);

  // Ref for scrolling to top when PDF loads
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  // DOCX preview state
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxError, setDocxError] = useState<string | null>(null);

  const isImage = attachment.mime_type?.startsWith("image/") ?? false;
  const isPdf = attachment.mime_type === "application/pdf";
  const isDocx = isDocxMimeType(attachment.mime_type);
  const hasStoragePath = Boolean(attachment.storage_path);

  // Load image as base64 data URL (CSP blocks file:// URLs)
  useEffect(() => {
    if (isImage && attachment.storage_path && attachment.mime_type) {
      setImageLoading(true);
      setImageError(false);
      const api = window.api?.transactions;
      if (api?.getAttachmentData) {
        api
          .getAttachmentData(attachment.storage_path, attachment.mime_type)
          .then((result: { success: boolean; data?: string; error?: string }) => {
            if (result.success && result.data) {
              setImageUrl(result.data);
            } else {
              setImageError(true);
            }
          })
          .catch(() => {
            setImageError(true);
          })
          .finally(() => {
            setImageLoading(false);
          });
      } else {
        // Fallback for tests or missing API
        setImageError(true);
        setImageLoading(false);
      }
    }
  }, [isImage, attachment.storage_path, attachment.mime_type]);

  // Load PDF as base64 data URL
  useEffect(() => {
    if (isPdf && attachment.storage_path) {
      setPdfLoading(true);
      setPdfError(null);
      const api = window.api?.transactions;
      if (api?.getAttachmentData) {
        api
          .getAttachmentData(attachment.storage_path, "application/pdf")
          .then((result: { success: boolean; data?: string; error?: string }) => {
            if (result.success && result.data) {
              setPdfData(result.data);
            } else {
              setPdfError(result.error || "Failed to load PDF");
            }
          })
          .catch((err: Error) => {
            setPdfError(err.message || "Failed to load PDF");
          })
          .finally(() => {
            setPdfLoading(false);
          });
      } else {
        setPdfError("PDF preview not available");
        setPdfLoading(false);
      }
    }
  }, [isPdf, attachment.storage_path]);

  // Load DOCX and convert to HTML
  useEffect(() => {
    if (isDocx && attachment.storage_path) {
      setDocxLoading(true);
      setDocxError(null);
      const api = window.api?.transactions;
      if (api?.getAttachmentBuffer) {
        api
          .getAttachmentBuffer(attachment.storage_path)
          .then(
            async (result: {
              success: boolean;
              data?: string;
              error?: string;
            }) => {
              if (result.success && result.data) {
                try {
                  // Convert base64 to ArrayBuffer
                  const binaryString = atob(result.data);
                  const bytes = new Uint8Array(binaryString.length);
                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  const arrayBuffer = bytes.buffer;

                  // BACKLOG-1126: Lazy-load mammoth only when a DOCX is opened
                  const mammoth = await import("mammoth");
                  const convertFn = mammoth.default?.convertToHtml ?? mammoth.convertToHtml;
                  // Convert DOCX to HTML using mammoth
                  const convertResult = await convertFn({
                    arrayBuffer,
                  });
                  // Sanitize HTML to prevent XSS
                  const sanitizedHtml = DOMPurify.sanitize(convertResult.value, {
                    USE_PROFILES: { html: true },
                  });
                  setDocxHtml(sanitizedHtml);
                } catch (err) {
                  setDocxError(
                    err instanceof Error
                      ? err.message
                      : "Failed to convert DOCX"
                  );
                }
              } else {
                setDocxError(result.error || "Failed to load DOCX");
              }
            }
          )
          .catch((err: Error) => {
            setDocxError(err.message || "Failed to load DOCX");
          })
          .finally(() => {
            setDocxLoading(false);
          });
      } else {
        setDocxError("DOCX preview not available");
        setDocxLoading(false);
      }
    }
  }, [isDocx, attachment.storage_path]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  // Handle open with system viewer
  const handleOpenWithSystem = () => {
    if (attachment.storage_path) {
      onOpenWithSystem(attachment.storage_path);
    }
  };

  // Handle PDF document load success - scroll to top
  const onDocumentLoadSuccess = useCallback(
    ({ numPages: pages }: { numPages: number }) => {
      setNumPages(pages);
      // Scroll the content area to top when PDF loads
      setTimeout(() => {
        pdfContainerRef.current?.scrollTo({ top: 0, behavior: "instant" });
      }, 100);
    },
    []
  );

  // Handle PDF document load error
  const onDocumentLoadError = useCallback((error: Error) => {
    setPdfError(error.message || "Failed to load PDF");
  }, []);

  const Icon = getFileIcon(attachment.mime_type);

  // Render loading spinner
  const renderLoading = (message: string) => (
    <div className="text-center py-12" data-testid="loading-state">
      <div className="w-16 h-16 border-4 border-gray-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4" />
      <p className="text-gray-500">{message}</p>
    </div>
  );

  // Render error state with fallback to system viewer
  const renderError = (message: string, testId: string) => (
    <div className="text-center py-12" data-testid={testId}>
      <Icon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
      <p className="text-gray-500 mb-4">{message}</p>
      {hasStoragePath && (
        <button
          onClick={handleOpenWithSystem}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 mx-auto"
        >
          <ExternalLink className="w-4 h-4" />
          Open with System Viewer
        </button>
      )}
    </div>
  );

  // Render PDF preview - all pages in scrollable view
  const renderPdfPreview = () => {
    if (pdfLoading) {
      return renderLoading("Loading PDF...");
    }

    if (pdfError) {
      return renderError(pdfError, "pdf-error-fallback");
    }

    if (!pdfData) {
      return null;
    }

    // Generate array of all page numbers
    const allPages = Array.from({ length: numPages }, (_, i) => i + 1);

    return (
      <div
        ref={pdfContainerRef}
        className="flex flex-col items-center w-full"
        data-testid="pdf-preview"
      >
        {/* Page count indicator - sticky at top */}
        {numPages > 1 && (
          <div className="sticky top-0 z-10 bg-white bg-opacity-90 backdrop-blur-sm rounded-lg shadow px-4 py-2 mb-4">
            <span className="text-sm text-gray-600">{numPages} pages • Scroll to navigate</span>
          </div>
        )}

        <Document
          file={pdfData}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          loading={renderLoading("Loading PDF...")}
          error={renderError("Failed to render PDF", "pdf-render-error")}
          className="max-w-full"
        >
          {/* Render all pages for natural scrolling */}
          <div className="space-y-4">
            {allPages.map((pageNum) => (
              <div key={pageNum} className="relative">
                <Page
                  pageNumber={pageNum}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  className="shadow-lg"
                  width={Math.min(800, window.innerWidth - 100)}
                />
                {/* Page number badge */}
                <div className="absolute bottom-2 right-2 bg-black bg-opacity-60 text-white text-xs px-2 py-1 rounded">
                  {pageNum} / {numPages}
                </div>
              </div>
            ))}
          </div>
        </Document>
      </div>
    );
  };

  // Render DOCX preview
  const renderDocxPreview = () => {
    if (docxLoading) {
      return renderLoading("Converting document...");
    }

    if (docxError) {
      return renderError(docxError, "docx-error-fallback");
    }

    if (!docxHtml) {
      return null;
    }

    return (
      <div
        className="bg-white rounded-lg shadow-lg p-6 max-w-4xl w-full overflow-auto max-h-[70vh]"
        data-testid="docx-preview"
      >
        <div
          className="prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: docxHtml }}
        />
      </div>
    );
  };

  // Render content based on file type
  const renderContent = () => {
    // BACKLOG-3884: no bytes → the "not downloaded" fallback below for every
    // type. The image/PDF/DOCX loaders need a path, so without this guard they
    // rendered an empty body.
    // Image preview
    if (isImage && hasStoragePath) {
      if (imageLoading) {
        return (
          <div className="text-center py-12" data-testid="image-loading">
            <div className="w-16 h-16 border-4 border-gray-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-500">Loading preview...</p>
          </div>
        );
      }

      if (imageUrl && !imageError) {
        return (
          <img
            src={imageUrl}
            alt={attachment.filename}
            className="max-w-full max-h-full object-contain rounded-lg shadow-lg"
            onError={() => setImageError(true)}
            data-testid="preview-image"
          />
        );
      }

      if (imageError) {
        return (
          <div className="text-center py-12" data-testid="image-error-fallback">
            <Image className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">Failed to load image</p>
            {hasStoragePath && (
              <button
                onClick={handleOpenWithSystem}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Open with System Viewer
              </button>
            )}
          </div>
        );
      }
    }

    // PDF preview
    if (isPdf && hasStoragePath) {
      return renderPdfPreview();
    }

    // DOCX preview
    if (isDocx && hasStoragePath) {
      return renderDocxPreview();
    }

    // Fallback for other file types
    return (
      <div className="text-center py-12" data-testid="non-image-fallback">
        <Icon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-900 font-medium mb-2">{attachment.filename}</p>
        <p className="text-gray-500 mb-4">
          {formatFileSize(attachment.file_size_bytes)}
        </p>
        {hasStoragePath && (
          <button
            onClick={handleOpenWithSystem}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 mx-auto"
          >
            <ExternalLink className="w-4 h-4" />
            Open with System Viewer
          </button>
        )}
        {!hasStoragePath && (
          <p className="text-gray-400 text-sm">Attachment not downloaded</p>
        )}
      </div>
    );
  };

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[100]" overlayClassName="bg-black bg-opacity-80" testId="attachment-preview-backdrop" panelClassName={MODAL_PANEL.lg}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-3 min-w-0">
            <Icon className="w-5 h-5 text-gray-500 flex-shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-gray-900 truncate">
                {attachment.filename}
              </h3>
              <p className="text-xs text-gray-500">
                {formatFileSize(attachment.file_size_bytes)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {hasStoragePath && (
              <button
                onClick={handleOpenWithSystem}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                data-testid="open-with-system-button"
              >
                <ExternalLink className="w-4 h-4" />
                Open
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-full transition-colors"
              aria-label="Close preview"
              data-testid="close-preview-button"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content - use items-start for scrollable content like PDFs */}
        <div className={`flex-1 overflow-auto p-4 flex justify-center bg-gray-50 ${isPdf ? "items-start" : "items-center"}`}>
          {renderContent()}
        </div>
    </ResponsiveModal>
  );
}
