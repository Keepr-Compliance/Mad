'use client';

/**
 * AttachmentLightbox - Full-screen preview dialog for attachments
 *
 * Shows a large preview of images with download button.
 * Non-image files show file info with download button.
 * Click backdrop or press Escape to close.
 */

import { useEffect, useCallback } from 'react';
import { X, Download, FileText } from 'lucide-react';
import { Button } from '@keepr/ui';

interface AttachmentLightboxProps {
  url: string;
  fileName: string;
  fileType: string;
  fileSize: string;
  onClose: () => void;
}

export function AttachmentLightbox({ url, fileName, fileType, fileSize, onClose }: AttachmentLightboxProps) {
  const isImage = fileType.startsWith('image/');

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [handleKeyDown]);

  function handleDownload() {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.target = '_blank';
    a.click();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />

      {/* Content */}
      <div className="relative z-10 max-w-[90vw] max-h-[90vh] flex flex-col items-center">
        {/* Top bar */}
        <div className="flex items-center justify-between w-full mb-3 px-1">
          <div className="text-white text-sm truncate max-w-[60%]">
            {fileName} <span className="text-white/60">({fileSize})</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-white/20 hover:bg-white/30 rounded-md transition-colors"
            >
              <Download className="h-4 w-4" />
              Download
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-white/80 hover:text-white hover:bg-white/20 rounded-md transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Preview */}
        {isImage ? (
          <img
            src={url}
            alt={fileName}
            className="max-w-full max-h-[80vh] rounded-lg object-contain"
          />
        ) : (
          <div className="bg-white rounded-lg p-12 text-center">
            <FileText className="mx-auto h-12 w-12 text-gray-300 mb-4" />
            <p className="text-lg font-medium text-gray-900 mb-1">{fileName}</p>
            <p className="text-sm text-gray-500 mb-4">{fileSize}</p>
            <Button variant="primary" onClick={handleDownload}>
              <Download className="h-4 w-4" />
              Download File
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
