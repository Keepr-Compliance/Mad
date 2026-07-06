'use client';

/**
 * AttachmentList - Customer Portal Ticket Attachments
 *
 * Displays uploaded attachments as download links with filename and size.
 * Generates signed URLs from Supabase Storage on click.
 */

import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FileText, FileSpreadsheet, Image, Play, Paperclip } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { SupportTicketAttachment } from '@/lib/support-types';
import { formatFileSize } from './FileUpload';

interface AttachmentListProps {
  attachments: SupportTicketAttachment[];
}

function getFileIcon(fileType: string): LucideIcon {
  if (fileType.startsWith('image/')) return Image;
  if (fileType === 'application/pdf') return FileText;
  if (fileType.startsWith('video/')) return Play;
  if (fileType.includes('spreadsheet') || fileType === 'text/csv') return FileSpreadsheet;
  if (fileType.includes('word') || fileType.includes('document')) return FileText;
  return Paperclip;
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload(attachment: SupportTicketAttachment) {
    setDownloading(attachment.id);
    setError(null);

    try {
      const supabase = createClient();
      const { data, error: urlError } = await supabase.storage
        .from('support-attachments')
        .createSignedUrl(attachment.storage_path, 3600);

      if (urlError) throw urlError;
      if (data?.signedUrl) {
        window.open(data.signedUrl, '_blank');
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
        {attachments.map((att) => {
          const FileIcon = getFileIcon(att.file_type);
          return (
            <button
              key={att.id}
              onClick={() => handleDownload(att)}
              disabled={downloading === att.id}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded border border-gray-200 text-gray-700 transition-colors disabled:opacity-50"
              title={`Download ${att.file_name} (${formatFileSize(att.file_size)})`}
            >
              <FileIcon className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <span className="truncate max-w-[120px]">{att.file_name}</span>
              <span className="text-gray-400">({formatFileSize(att.file_size)})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
