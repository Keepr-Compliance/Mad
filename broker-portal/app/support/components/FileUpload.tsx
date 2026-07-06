'use client';

/**
 * FileUpload - Customer Portal Attachments
 *
 * File upload component with drag-and-drop support, file type validation,
 * size limits. Used in CustomerReplyForm and TicketForm.
 */

import { useState, useRef, useCallback } from 'react';
import { Upload } from 'lucide-react';

const ALLOWED_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt',
  'doc', 'docx', 'csv', 'xlsx', 'mp4', 'mov', 'zip',
];

const ALLOWED_TYPES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'video/mp4', 'video/quicktime',
  'application/zip',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export interface PendingFile {
  id: string;
  file: File;
  name: string;
  size: number;
  type: string;
  error?: string;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

function validateFile(file: File): string | undefined {
  if (file.size > MAX_FILE_SIZE) {
    return `File exceeds 10MB limit (${formatFileSize(file.size)})`;
  }
  const ext = getFileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext) && !ALLOWED_TYPES.includes(file.type)) {
    return `File type not allowed: .${ext}`;
  }
  return undefined;
}

interface FileUploadProps {
  files: PendingFile[];
  onFilesChange: (files: PendingFile[]) => void;
  disabled?: boolean;
}

export function FileUpload({ files, onFilesChange, disabled }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((newFiles: FileList | File[]) => {
    const additions: PendingFile[] = Array.from(newFiles).map((file) => ({
      id: crypto.randomUUID(),
      file,
      name: file.name,
      size: file.size,
      type: file.type,
      error: validateFile(file),
    }));
    onFilesChange([...files, ...additions]);
  }, [files, onFilesChange]);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  }

  function removeFile(fileId: string) {
    onFilesChange(files.filter((f) => f.id !== fileId));
  }

  return (
    <div>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-md p-3 text-center cursor-pointer transition-colors ${
          isDragging
            ? 'border-primary-400 bg-primary-50'
            : disabled
              ? 'border-gray-200 bg-gray-50 cursor-not-allowed'
              : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        <Upload className="mx-auto h-5 w-5 text-gray-400 mb-1" />
        <p className="text-xs text-gray-500">
          Drop files here or <span className="text-primary-600 underline">browse</span>
        </p>
        <p className="text-xs text-gray-400 mt-0.5">
          Max 10MB per file
        </p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          disabled={disabled}
        />
      </div>

      {files.length > 0 && (
        <ul className="mt-2 space-y-1">
          {files.map((f) => (
            <li
              key={f.id}
              className={`flex items-center justify-between text-xs px-2 py-1.5 rounded ${
                f.error ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-700'
              }`}
            >
              <div className="flex-1 min-w-0">
                <span className="truncate block">{f.name}</span>
                {f.error ? (
                  <span className="text-red-500">{f.error}</span>
                ) : (
                  <span className="text-gray-400">{formatFileSize(f.size)}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeFile(f.id)}
                className="ml-2 text-gray-400 hover:text-red-500 shrink-0"
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
