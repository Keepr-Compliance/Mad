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

import { useState, useMemo } from 'react';
import { AttachmentViewerModal } from './AttachmentViewerModal';
import { EmptyAttachments } from '@/components/ui/EmptyState';
import { useAttachmentThumbnailUrl } from './useAttachmentThumbnailUrl';
import { formatFileSize, isMediaFile, isVideoFile } from '@/lib/submissions/attachmentKinds';
import { sourceLine, type AttachmentSource } from '@/lib/submissions/attachmentSources';
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
  /**
   * BACKLOG-3682: attachment id -> the message it came from. Missing for older
   * submissions (no message_id), which then render exactly as before.
   */
  sources?: Record<string, AttachmentSource>;
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
  source,
  onClick
}: {
  attachment: Attachment;
  source?: AttachmentSource;
  onClick: () => void;
}) {
  // BACKLOG-3748: signing + HEIC conversion moved to a shared hook.
  const { url: thumbnailUrl, loading, error } = useAttachmentThumbnailUrl(attachment);
  const isVideo = isVideoFile(attachment);

  return (
    <button
      onClick={onClick}
      title={source ? `${attachment.filename}\n${sourceLine(source)}` : undefined}
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
        {source && (
          <p className="text-white/80 text-[11px] truncate" data-testid="attachment-source">
            {sourceLine(source)}
          </p>
        )}
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

export function AttachmentList({ attachments, sources }: AttachmentListProps) {
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
          {/* BACKLOG-3798: below md the title and the tabs stack, and the tabs
              wrap so the active one stays visible. md: restores the row. */}
          <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between md:gap-0">
            <h2 className="text-lg font-semibold text-gray-900">
              Attachments ({attachments.length})
            </h2>
            <div className="flex flex-wrap md:flex-nowrap gap-1 bg-gray-100 rounded-lg p-1">
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
                    source={sources?.[attachment.id]}
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
                  const source = sources?.[attachment.id];

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
                        {source && (
                          <p className="text-xs text-gray-500 truncate" data-testid="attachment-source">
                            {sourceLine(source)}
                          </p>
                        )}
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
