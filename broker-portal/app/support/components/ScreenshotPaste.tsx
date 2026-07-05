'use client';

/**
 * ScreenshotPaste - Clipboard paste and drag-and-drop for screenshots
 *
 * Listens for paste events at the document level to capture screenshots
 * from clipboard (Ctrl+V / Cmd+V). Also provides a drop zone for
 * dragging image files. Shows a preview with a remove button.
 *
 * Cleans up URL.createObjectURL in useEffect cleanup to prevent memory leaks.
 */

import { useEffect, useCallback, useState, useRef } from 'react';

interface ScreenshotPasteProps {
  onScreenshot: (file: File) => void;
  screenshot: File | null;
  onRemove: () => void;
  disabled?: boolean;
}

export function ScreenshotPaste({ onScreenshot, screenshot, onRemove, disabled }: ScreenshotPasteProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  // Handle clipboard paste at document level
  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (disabled) return;
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          onScreenshot(new File([file], `screenshot-${Date.now()}.png`, { type: file.type }));
          break;
        }
      }
    }
  }, [onScreenshot, disabled]);

  // Register document-level paste listener
  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  // Preview URL management -- clean up object URLs to prevent memory leaks
  useEffect(() => {
    if (screenshot) {
      const url = URL.createObjectURL(screenshot);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreviewUrl(null);
  }, [screenshot]);

  // Drag-and-drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;

    const files = e.dataTransfer?.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) {
        onScreenshot(file);
        break;
      }
    }
  }, [onScreenshot, disabled]);

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">
        Screenshot
      </label>

      {/* Preview or drop zone */}
      {previewUrl && screenshot ? (
        <div className="relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="Screenshot preview"
            className="max-h-40 rounded-md border border-gray-200"
          />
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600 disabled:opacity-50"
            aria-label="Remove screenshot"
          >
            &times;
          </button>
          <p className="text-xs text-gray-500 mt-1">{screenshot.name}</p>
        </div>
      ) : (
        <div
          ref={dropRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-md p-3 text-center transition-colors ${
            isDragging
              ? 'border-primary-400 bg-primary-50'
              : disabled
                ? 'border-gray-200 bg-gray-50 cursor-not-allowed'
                : 'border-gray-300'
          }`}
        >
          <p className="text-xs text-gray-500">
            Paste a screenshot (Ctrl+V / Cmd+V) or drag an image here
          </p>
        </div>
      )}
    </div>
  );
}
