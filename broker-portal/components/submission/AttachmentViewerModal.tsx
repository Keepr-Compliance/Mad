'use client';

/**
 * AttachmentViewerModal Component
 *
 * Preview and download attachments with signed URLs.
 * Part of BACKLOG-401.
 */

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import heic2any from 'heic2any';
import { AlertCircle, Download, FileText, Image as ImageIcon, Play, X } from 'lucide-react';
import { Button, Spinner } from '@keepr/design-system';

interface Attachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

interface AttachmentViewerModalProps {
  attachment: Attachment | null;
  open: boolean;
  onClose: () => void;
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentViewerModal({ attachment, open, onClose }: AttachmentViewerModalProps) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const supabase = createClient();

  // Check if file is HEIC/HEIF format
  const isHeic = attachment?.mime_type === 'image/heic' ||
    attachment?.mime_type === 'image/heif' ||
    attachment?.filename?.toLowerCase().endsWith('.heic') ||
    attachment?.filename?.toLowerCase().endsWith('.heif');

  useEffect(() => {
    if (!attachment || !open || !attachment.storage_path) {
      setSignedUrl(null);
      setDisplayUrl(null);
      return;
    }

    const fetchUrl = async () => {
      setLoading(true);
      setError(null);

      try {
        const { data, error: storageError } = await supabase.storage
          .from('submission-attachments')
          .createSignedUrl(attachment.storage_path!, 3600); // 1 hour

        if (storageError) throw storageError;
        setSignedUrl(data.signedUrl);

        // If HEIC, convert to displayable format
        if (isHeic) {
          setConverting(true);
          try {
            const response = await fetch(data.signedUrl);
            const blob = await response.blob();
            const convertedBlob = await heic2any({
              blob,
              toType: 'image/jpeg',
              quality: 0.8,
            });
            // heic2any can return array or single blob
            const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
            const objectUrl = URL.createObjectURL(resultBlob);
            setDisplayUrl(objectUrl);
          } catch (conversionError) {
            console.error('HEIC conversion failed:', conversionError);
            // Fall back to download-only if conversion fails
            setDisplayUrl(null);
          } finally {
            setConverting(false);
          }
        } else {
          setDisplayUrl(data.signedUrl);
        }
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.error('Failed to get signed URL:', {
          filename: attachment.filename,
          storagePath: attachment.storage_path,
          error: errorMessage,
        });
        setError(`Failed to load attachment: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    };

    fetchUrl();

    // Cleanup object URL on unmount
    return () => {
      if (displayUrl && displayUrl.startsWith('blob:')) {
        URL.revokeObjectURL(displayUrl);
      }
    };
  }, [attachment, open, supabase.storage, isHeic]);

  if (!attachment || !open) return null;

  const isImage = attachment.mime_type?.startsWith('image/');
  const isPdf = attachment.mime_type === 'application/pdf';
  const isVideo = attachment.mime_type?.startsWith('video/') ||
    ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'].some(ext => attachment.filename.toLowerCase().endsWith(ext));
  const canPreview = isImage || isPdf || isVideo;

  const handleDownload = () => {
    if (signedUrl) {
      window.open(signedUrl, '_blank');
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* File icon */}
            <div
              className={`p-2 rounded-lg ${
                isImage
                  ? 'text-blue-600 bg-blue-50'
                  : isPdf
                    ? 'text-red-600 bg-red-50'
                    : isVideo
                      ? 'text-purple-600 bg-purple-50'
                      : 'text-gray-600 bg-gray-100'
              }`}
            >
              {isImage ? (
                <ImageIcon className="w-5 h-5" />
              ) : isPdf ? (
                <FileText className="w-5 h-5" />
              ) : isVideo ? (
                <Play className="w-5 h-5" fill="currentColor" />
              ) : (
                <FileText className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{attachment.filename}</h2>
              <p className="text-sm text-gray-500">
                {attachment.mime_type || 'Unknown type'} | {formatFileSize(attachment.file_size_bytes)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Download button */}
            <Button onClick={handleDownload} disabled={!signedUrl || loading}>
              <Download className="h-4 w-4" />
              Download
            </Button>
            {/* Close button */}
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 rounded"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-gray-100">
          {/* Loading state */}
          {(loading || converting) && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <Spinner className="mx-auto mb-2" />
                <p className="text-sm text-gray-500">
                  {converting ? 'Converting HEIC image...' : 'Loading preview...'}
                </p>
              </div>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center text-red-500">
                <AlertCircle className="w-12 h-12 mx-auto mb-2" />
                <p className="text-sm">{error}</p>
              </div>
            </div>
          )}

          {/* Preview content */}
          {signedUrl && !loading && !converting && !error && (
            <>
              {/* Image preview */}
              {isImage && displayUrl && (
                <div className="flex items-center justify-center p-4 min-h-[300px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={displayUrl}
                    alt={attachment.filename}
                    className="max-w-full max-h-[70vh] object-contain"
                  />
                </div>
              )}

              {/* HEIC conversion failed - show download prompt */}
              {isImage && isHeic && !displayUrl && (
                <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                  <ImageIcon className="h-12 w-12 text-gray-300 mb-4" />
                  <p className="text-lg font-medium mb-1">HEIC Image</p>
                  <p className="text-sm mb-4">This Apple image format could not be converted for preview</p>
                  <Button onClick={handleDownload}>Download to view</Button>
                </div>
              )}

              {/* PDF preview */}
              {isPdf && (
                <iframe
                  src={signedUrl}
                  className="w-full h-[70vh]"
                  title={attachment.filename}
                />
              )}

              {/* Video preview */}
              {isVideo && (
                <div className="flex items-center justify-center p-4 min-h-[300px]">
                  <video
                    src={signedUrl}
                    controls
                    className="max-w-full max-h-[70vh]"
                  >
                    Your browser does not support the video tag.
                  </video>
                </div>
              )}

              {/* No preview available */}
              {!canPreview && (
                <div className="flex flex-col items-center justify-center h-64 text-gray-500">
                  <FileText className="h-12 w-12 text-gray-300 mb-4" />
                  <p className="text-lg font-medium mb-1">Preview not available</p>
                  <p className="text-sm mb-4">This file type cannot be previewed in the browser</p>
                  <Button variant="secondary" onClick={handleDownload}>
                    Download to view
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default AttachmentViewerModal;
