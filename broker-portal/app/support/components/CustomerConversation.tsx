'use client';

/**
 * CustomerConversation - Customer Ticket Detail
 *
 * CustomerTicketDescription: Pinned original description card.
 * CustomerMessageList: Messages newest first, internal notes filtered out.
 * Customer messages right-aligned (blue), agent messages left-aligned (white).
 * Attachments shown inline with thumbnails + lightbox preview.
 */

import { useState, useEffect } from 'react';
import { Paperclip } from 'lucide-react';
import type { SupportTicketMessage, SupportTicketAttachment } from '@/lib/support-types';
import { getAttachmentUrl } from '@/lib/support-queries';
import { AttachmentLightbox } from './AttachmentLightbox';

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentThumbnail({
  attachment,
  onPreview,
}: {
  attachment: SupportTicketAttachment;
  onPreview: (url: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loading, setLoading] = useState(false);

  const isImage = attachment.file_type.startsWith('image/');

  useEffect(() => {
    if (isImage) {
      getAttachmentUrl(attachment.storage_path)
        .then(setUrl)
        .catch(() => setLoadError(true));
    }
  }, [isImage, attachment.storage_path]);

  async function handleClick() {
    if (url) {
      onPreview(url);
      return;
    }
    setLoading(true);
    try {
      const signedUrl = await getAttachmentUrl(attachment.storage_path);
      setUrl(signedUrl);
      onPreview(signedUrl);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  if (isImage && url && !loadError) {
    return (
      <button
        onClick={handleClick}
        className="block group relative rounded-md overflow-hidden border border-gray-200 hover:border-primary-400 transition-colors"
      >
        <img
          src={url}
          alt={attachment.file_name}
          className="h-20 w-auto object-cover rounded-md"
          onError={() => setLoadError(true)}
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded-md" />
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-gray-50 border border-gray-200 rounded-md hover:bg-gray-100 hover:border-primary-400 transition-colors disabled:opacity-50"
    >
      <Paperclip className="h-3 w-3 text-gray-400" />
      <span className="text-gray-700 truncate max-w-[120px]">{attachment.file_name}</span>
      <span className="text-gray-400">({formatFileSize(attachment.file_size)})</span>
    </button>
  );
}

function InlineAttachments({
  attachments,
  onPreview,
}: {
  attachments: SupportTicketAttachment[];
  onPreview: (url: string, att: SupportTicketAttachment) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((att) => (
        <AttachmentThumbnail
          key={att.id}
          attachment={att}
          onPreview={(url) => onPreview(url, att)}
        />
      ))}
    </div>
  );
}

/**
 * CustomerTicketDescription - Pinned original ticket description card.
 * Used by the customer detail page. Right-aligned to match customer message styling.
 */
export function CustomerTicketDescription({
  description,
  requesterName,
  createdAt,
  attachments,
  showAttachments = true,
}: {
  description: string;
  requesterName: string;
  createdAt: string;
  attachments: SupportTicketAttachment[];
  showAttachments?: boolean;
}) {
  const [lightbox, setLightbox] = useState<{
    url: string;
    attachment: SupportTicketAttachment;
  } | null>(null);

  function openLightbox(url: string, att: SupportTicketAttachment) {
    setLightbox({ url, attachment: att });
  }

  return (
    <>
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div className="bg-primary-50 border border-primary-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-900">{requesterName}</span>
              <span className="text-xs text-gray-400 ml-3">{formatTimestamp(createdAt)}</span>
            </div>
            <div className="text-sm text-gray-700 whitespace-pre-wrap">{description}</div>
            {showAttachments && (
              <InlineAttachments
                attachments={attachments}
                onPreview={openLightbox}
              />
            )}
          </div>
        </div>
      </div>

      {lightbox && (
        <AttachmentLightbox
          url={lightbox.url}
          fileName={lightbox.attachment.file_name}
          fileType={lightbox.attachment.file_type}
          fileSize={formatFileSize(lightbox.attachment.file_size)}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}

/**
 * CustomerMessageList - Customer message list, newest first.
 * Filters out internal notes (defense-in-depth) and renders customer vs agent messages
 * with distinct styling (right-aligned for customer, left-aligned for agent).
 */
export function CustomerMessageList({
  messages,
  attachments,
  requesterEmail,
  showAttachments = true,
}: {
  messages: SupportTicketMessage[];
  attachments: SupportTicketAttachment[];
  requesterEmail: string;
  showAttachments?: boolean;
}) {
  const [lightbox, setLightbox] = useState<{
    url: string;
    attachment: SupportTicketAttachment;
  } | null>(null);

  // Filter out internal notes (defense-in-depth)
  const publicMessages = messages.filter((m) => m.message_type !== 'internal_note');

  // Group attachments by message_id
  const attachmentsByMessage = new Map<string, SupportTicketAttachment[]>();
  for (const att of attachments) {
    if (!att.message_id) continue;
    if (!attachmentsByMessage.has(att.message_id)) {
      attachmentsByMessage.set(att.message_id, []);
    }
    attachmentsByMessage.get(att.message_id)!.push(att);
  }

  // Reverse: newest first
  const sortedMessages = [...publicMessages].reverse();

  function openLightbox(url: string, att: SupportTicketAttachment) {
    setLightbox({ url, attachment: att });
  }

  if (sortedMessages.length === 0) {
    return (
      <div className="text-center py-6 text-gray-400 text-sm">
        No replies yet. A support agent will respond soon.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        {sortedMessages.map((message) => {
          const isCustomer = message.sender_email === requesterEmail;
          const msgAttachments = attachmentsByMessage.get(message.id) || [];

          return (
            <div key={message.id} className={`flex ${isCustomer ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[80%]">
                <div
                  className={`rounded-lg p-4 ${
                    isCustomer
                      ? 'bg-primary-50 border border-primary-200'
                      : 'bg-white border border-gray-200'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-gray-900">
                      {isCustomer
                        ? message.sender_name || 'You'
                        : message.sender_name || 'Support Agent'}
                    </span>
                    <span className="text-xs text-gray-400 ml-3">
                      {formatTimestamp(message.created_at)}
                    </span>
                  </div>
                  <div className="text-sm text-gray-700 whitespace-pre-wrap">{message.body}</div>
                  {showAttachments && (
                    <InlineAttachments attachments={msgAttachments} onPreview={openLightbox} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {lightbox && (
        <AttachmentLightbox
          url={lightbox.url}
          fileName={lightbox.attachment.file_name}
          fileType={lightbox.attachment.file_type}
          fileSize={formatFileSize(lightbox.attachment.file_size)}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}
