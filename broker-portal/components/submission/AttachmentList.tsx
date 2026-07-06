'use client';

/**
 * AttachmentList Component
 *
 * Displays attachments split into two sections:
 * 1. Media Gallery (images, videos, GIFs) - with thumbnail previews
 * 2. Documents (PDFs, Word, Excel, etc.) - in a list view
 *
 * Part of BACKLOG-401.
 */

import { useState, useEffect, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { AttachmentViewerModal } from './AttachmentViewerModal';
import { EmptyAttachments } from '@/components/ui/EmptyState';
import heic2any from 'heic2any';
import {
  Eye,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  Play,
  Presentation,
} from 'lucide-react';

interface Attachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
  document_type: string | null;
}

interface AttachmentListProps {
  attachments: Attachment[];
}

// Media file extensions and MIME types
const MEDIA_EXTENSIONS = [
  // Images
  '.jpg', '.jpeg', '.png', '.gif', '.heic', '.heif', '.webp', '.bmp', '.tiff', '.tif',
  '.raw', '.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef', '.srw',
  // Videos
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv', '.3gp',
];

const MEDIA_MIME_TYPES = [
  'image/', 'video/',
];

function isMediaFile(attachment: Attachment): boolean {
  const mimeType = attachment.mime_type?.toLowerCase() || '';
  const filename = attachment.filename.toLowerCase();

  // Check MIME type
  if (MEDIA_MIME_TYPES.some(type => mimeType.startsWith(type))) {
    return true;
  }

  // Check file extension
  if (MEDIA_EXTENSIONS.some(ext => filename.endsWith(ext))) {
    return true;
  }

  return false;
}

function isVideoFile(attachment: Attachment): boolean {
  const mimeType = attachment.mime_type?.toLowerCase() || '';
  const filename = attachment.filename.toLowerCase();

  if (mimeType.startsWith('video/')) return true;

  const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv', '.3gp'];
  return videoExtensions.some(ext => filename.endsWith(ext));
}

function isHeicFile(attachment: Attachment): boolean {
  const mimeType = attachment.mime_type?.toLowerCase() || '';
  const filename = attachment.filename.toLowerCase();

  return mimeType === 'image/heic' ||
    mimeType === 'image/heif' ||
    filename.endsWith('.heic') ||
    filename.endsWith('.heif');
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getDocumentIcon(attachment: Attachment): { icon: 'pdf' | 'excel' | 'word' | 'powerpoint' | 'other'; color: string } {
  const mimeType = attachment.mime_type?.toLowerCase() || '';
  const filename = attachment.filename.toLowerCase();

  // PDF
  if (mimeType.includes('pdf') || filename.endsWith('.pdf')) {
    return { icon: 'pdf', color: 'text-red-600 bg-red-50' };
  }

  // Excel
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') ||
      filename.endsWith('.xls') || filename.endsWith('.xlsx') || filename.endsWith('.csv')) {
    return { icon: 'excel', color: 'text-green-600 bg-green-50' };
  }

  // Word
  if (mimeType.includes('word') || mimeType.includes('document') ||
      filename.endsWith('.doc') || filename.endsWith('.docx')) {
    return { icon: 'word', color: 'text-blue-600 bg-blue-50' };
  }

  // PowerPoint
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint') ||
      filename.endsWith('.ppt') || filename.endsWith('.pptx')) {
    return { icon: 'powerpoint', color: 'text-orange-600 bg-orange-50' };
  }

  return { icon: 'other', color: 'text-gray-600 bg-gray-50' };
}

// Media thumbnail component with lazy loading
function MediaThumbnail({
  attachment,
  onClick
}: {
  attachment: Attachment;
  onClick: () => void;
}) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const supabase = createClient();
  const isVideo = isVideoFile(attachment);
  const isHeic = isHeicFile(attachment);

  useEffect(() => {
    if (!attachment.storage_path) {
      setLoading(false);
      return;
    }

    const fetchUrl = async () => {
      try {
        const { data, error: storageError } = await supabase.storage
          .from('submission-attachments')
          .createSignedUrl(attachment.storage_path!, 3600);

        if (storageError) throw storageError;

        // Convert HEIC to displayable format
        if (isHeic) {
          try {
            const response = await fetch(data.signedUrl);
            const blob = await response.blob();
            const convertedBlob = await heic2any({
              blob,
              toType: 'image/jpeg',
              quality: 0.7, // Lower quality for thumbnails
            });
            const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
            const objectUrl = URL.createObjectURL(resultBlob);
            setThumbnailUrl(objectUrl);
          } catch (conversionError) {
            console.error('HEIC thumbnail conversion failed:', conversionError);
            setError(true);
          }
        } else {
          setThumbnailUrl(data.signedUrl);
        }
      } catch (err) {
        console.error('Failed to load attachment thumbnail:', {
          filename: attachment.filename,
          storagePath: attachment.storage_path,
          error: err instanceof Error ? err.message : err,
        });
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchUrl();

    // Cleanup object URL on unmount
    return () => {
      if (thumbnailUrl && thumbnailUrl.startsWith('blob:')) {
        URL.revokeObjectURL(thumbnailUrl);
      }
    };
  }, [attachment.storage_path, supabase.storage, isHeic]);

  return (
    <button
      onClick={onClick}
      className="relative aspect-square rounded-lg overflow-hidden bg-gray-100 hover:opacity-90 transition-opacity group focus:outline-none focus:ring-2 focus:ring-primary-500"
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-gray-300" />
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-gray-400">
          <ImageOff className="w-8 h-8" />
        </div>
      )}

      {thumbnailUrl && !loading && !error && (
        <>
          {isVideo ? (
            <div className="absolute inset-0 bg-black flex items-center justify-center">
              {/* Video thumbnail - show first frame would require additional processing */}
              <div className="text-white">
                <Play className="w-12 h-12" fill="currentColor" />
              </div>
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbnailUrl}
              alt={attachment.filename}
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
        </>
      )}

      {/* Video play icon overlay */}
      {isVideo && thumbnailUrl && !loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-30 group-hover:bg-opacity-40 transition-colors">
          <div className="w-12 h-12 bg-white bg-opacity-90 rounded-full flex items-center justify-center">
            <Play className="w-6 h-6 text-gray-900 ml-1" fill="currentColor" />
          </div>
        </div>
      )}

      {/* Filename tooltip on hover */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="text-white text-xs truncate">{attachment.filename}</p>
      </div>
    </button>
  );
}

// Document icons (lucide)
function DocumentIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'excel':
      return <FileSpreadsheet className={className} />;
    case 'powerpoint':
      return <Presentation className={className} />;
    case 'pdf':
    case 'word':
    default:
      return <FileText className={className} />;
  }
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  const [selectedAttachment, setSelectedAttachment] = useState<Attachment | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'media' | 'documents'>('documents');

  // Split attachments into media and documents
  const { mediaFiles, documentFiles } = useMemo(() => {
    const media: Attachment[] = [];
    const docs: Attachment[] = [];

    for (const attachment of attachments) {
      if (isMediaFile(attachment)) {
        media.push(attachment);
      } else {
        docs.push(attachment);
      }
    }

    return { mediaFiles: media, documentFiles: docs };
  }, [attachments]);

  if (attachments.length === 0) {
    return (
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Attachments (0)</h2>
        </div>
        <EmptyAttachments />
      </div>
    );
  }

  const tabs = [
    { value: 'all' as const, label: 'All', count: attachments.length },
    { value: 'media' as const, label: 'Media', count: mediaFiles.length },
    { value: 'documents' as const, label: 'Documents', count: documentFiles.length },
  ];

  const displayedMedia = activeTab === 'documents' ? [] : mediaFiles;
  const displayedDocs = activeTab === 'media' ? [] : documentFiles;

  return (
    <>
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
        {/* Header with tabs */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              Attachments ({attachments.length})
            </h2>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              {tabs.map(({ value, label, count }) => (
                <button
                  key={value}
                  onClick={() => setActiveTab(value)}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    activeTab === value
                      ? 'bg-white text-gray-900 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {label} ({count})
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Media Gallery */}
          {displayedMedia.length > 0 && (
            <div>
              {activeTab === 'all' && (
                <h3 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <ImageIcon className="w-4 h-4" />
                  Media ({mediaFiles.length})
                </h3>
              )}
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
                {displayedMedia.map((attachment) => (
                  <MediaThumbnail
                    key={attachment.id}
                    attachment={attachment}
                    onClick={() => setSelectedAttachment(attachment)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Documents List */}
          {displayedDocs.length > 0 && (
            <div>
              {activeTab === 'all' && (
                <h3 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Documents ({documentFiles.length})
                </h3>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {displayedDocs.map((attachment) => {
                  const { icon, color } = getDocumentIcon(attachment);

                  return (
                    <button
                      key={attachment.id}
                      onClick={() => setSelectedAttachment(attachment)}
                      className="flex items-center gap-3 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-colors text-left group"
                    >
                      {/* File icon */}
                      <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
                        <DocumentIcon type={icon} className="w-5 h-5" />
                      </div>

                      {/* File info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate group-hover:text-primary-600">
                          {attachment.filename}
                        </p>
                        <p className="text-xs text-gray-500">
                          {attachment.document_type && (
                            <span className="capitalize">{attachment.document_type} - </span>
                          )}
                          {formatFileSize(attachment.file_size_bytes)}
                        </p>
                      </div>

                      {/* View indicator */}
                      <div className="flex-shrink-0 text-gray-400 group-hover:text-primary-500">
                        <Eye className="w-5 h-5" />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Attachment Viewer Modal */}
      <AttachmentViewerModal
        attachment={selectedAttachment}
        open={!!selectedAttachment}
        onClose={() => setSelectedAttachment(null)}
      />
    </>
  );
}

export default AttachmentList;
