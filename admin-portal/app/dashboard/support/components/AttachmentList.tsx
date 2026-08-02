'use client';

/**
 * AttachmentList - Support Ticket Attachments
 *
 * Displays uploaded attachments as download links with filename and size.
 * Generates signed URLs from Supabase Storage on click.
 */

import { useState } from 'react';
import type { SupportTicketAttachment } from '@/lib/support-types';
import { formatFileSize } from './FileUpload';
import { getAttachmentUrl } from '@/lib/support-queries';

interface AttachmentListProps {
  attachments: SupportTicketAttachment[];
}

function getFileIcon(fileType: string): string {
  if (fileType.startsWith('image/')) return '[IMG]';
  if (fileType === 'application/pdf') return '[PDF]';
  if (fileType.startsWith('video/')) return '[VID]';
  if (fileType.includes('spreadsheet') || fileType === 'text/csv') return '[XLS]';
  if (fileType.includes('word') || fileType.includes('document')) return '[DOC]';
  if (fileType === 'application/zip') return '[ZIP]';
  return '[FILE]';
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload(attachment: SupportTicketAttachment) {
    setDownloading(attachment.id);
    setError(null);

    try {
      // BACKLOG-2393: go through getAttachmentUrl so the read is recorded.
      // Minting a signed URL inline here would be an unlogged read.
      const signedUrl = await getAttachmentUrl(
        attachment.storage_path,
        attachment.id
      );
      if (signedUrl) {
        window.open(signedUrl, '_blank');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download');
    } finally {
      setDownloading(null);
    }
  }

  if (attachments.length === 0) return null;

  return (
    <div className="mt-2">
      {error && (
        <div className="text-xs text-red-600 mb-1">{error}</div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {attachments.map((att) => (
          <button
            key={att.id}
            onClick={() => handleDownload(att)}
            disabled={downloading === att.id}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border border-gray-200 text-gray-700 transition-colors disabled:opacity-50"
            title={`Download ${att.file_name} (${formatFileSize(att.file_size)})`}
          >
            <span className="font-mono text-gray-400">{getFileIcon(att.file_type)}</span>
            <span className="truncate max-w-[120px]">{att.file_name}</span>
            <span className="text-gray-400">({formatFileSize(att.file_size)})</span>
          </button>
        ))}
      </div>
    </div>
  );
}
