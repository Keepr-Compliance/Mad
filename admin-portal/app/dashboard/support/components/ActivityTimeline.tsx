'use client';

/**
 * ActivityTimeline - Unified chronological timeline for ticket detail.
 *
 * Merges messages and events into a single stream sorted oldest-first.
 * Messages render as cards (same style as ConversationThread MessageList).
 * Events render as compact inline system pills (centered, gray).
 * Filters out `message_added` events since the message itself is shown.
 *
 * Internal notes authored by the current user show edit/delete controls
 * on hover (TASK-2315 / BACKLOG-1344).
 */

import { useState, useEffect } from 'react';
import { Lock, Paperclip, Pencil, Trash2 } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import type {
  SupportTicketMessage,
  SupportTicketEvent,
  SupportTicketAttachment,
} from '@/lib/support-types';
import { buildTimeline, getEventIcon, getEventDescription, getActorName } from '@/lib/timeline-utils';
import { getAttachmentUrl, editInternalNote, deleteInternalNote } from '@/lib/support-queries';
import { AttachmentLightbox } from './AttachmentLightbox';

// ─── Props ───────────────────────────────────────────────────────────

interface ActivityTimelineProps {
  messages: SupportTicketMessage[];
  events: SupportTicketEvent[];
  attachments: SupportTicketAttachment[];
  showAttachments?: boolean;
  onTimelineChanged?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────

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

function formatEventTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
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

// ─── Sub-components ──────────────────────────────────────────────────

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
 * MessageCard - Renders a single message in the timeline.
 * Preserves the internal note amber/yellow styling with lock icon.
 * Shows edit/delete controls on hover for own internal notes.
 */
function MessageCard({
  message,
  attachments,
  showAttachments,
  currentUserId,
  onPreview,
  onEdited,
  onDeleted,
}: {
  message: SupportTicketMessage;
  attachments: SupportTicketAttachment[];
  showAttachments: boolean;
  currentUserId: string | null;
  onPreview: (url: string, att: SupportTicketAttachment) => void;
  onEdited?: () => void;
  onDeleted?: () => void;
}) {
  const isNote = message.message_type === 'internal_note';
  const isOwnMessage = currentUserId != null && message.sender_id === currentUserId;
  const canModify = isNote && isOwnMessage;

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.body);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSaveEdit() {
    if (!editText.trim() || editText === message.body) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await editInternalNote(message.id, editText.trim());
      setEditing(false);
      onEdited?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save edit');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteInternalNote(message.id);
      setConfirmDelete(false);
      onDeleted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete note');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className={`group rounded-lg p-4 ${
        isNote
          ? 'bg-amber-50 border border-amber-200'
          : 'bg-white border border-gray-200'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isNote && (
            <div className="flex items-center gap-1 text-amber-600 text-xs font-medium">
              <Lock className="h-3 w-3" />
              Internal Note
            </div>
          )}
          <span className="text-sm font-medium text-gray-900">
            {message.sender_name || message.sender_email || 'System'}
          </span>
          {message.sender_email && message.sender_name && (
            <span className="text-xs text-gray-400">{message.sender_email}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canModify && !editing && !confirmDelete && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => { setEditText(message.body); setEditing(true); }}
                className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                title="Edit note"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setConfirmDelete(true)}
                className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                title="Delete note"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <span className="text-xs text-gray-400">
            {formatTimestamp(message.created_at)}
            {message.edited_at && (
              <span className="ml-1 text-gray-400">(edited)</span>
            )}
          </span>
        </div>
      </div>

      {/* Inline edit mode */}
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            className="w-full px-3 py-2 text-sm text-gray-900 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent resize-y min-h-[60px]"
            rows={3}
            disabled={saving}
            autoFocus
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveEdit}
              disabled={saving || !editText.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setError(null); }}
              disabled={saving}
              className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : confirmDelete ? (
        /* Inline delete confirmation */
        <div className="space-y-2">
          <p className="text-sm text-gray-700">
            Are you sure you want to delete this internal note? This cannot be undone.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-md transition-colors disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
            <button
              onClick={() => { setConfirmDelete(false); setError(null); }}
              disabled={deleting}
              className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        /* Normal message body */
        <div className="text-sm text-gray-700 whitespace-pre-wrap">{message.body}</div>
      )}

      {showAttachments && !editing && !confirmDelete && (
        <InlineAttachments attachments={attachments} onPreview={onPreview} />
      )}
    </div>
  );
}

/**
 * EventInlineCard - Compact centered pill for system events.
 */
function EventInlineCard({ event }: { event: SupportTicketEvent }) {
  const icon = getEventIcon(event.event_type);
  const description = getEventDescription(event);
  const actorName = getActorName(event);

  return (
    <div className="flex items-center justify-center py-1">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-full text-xs text-gray-500">
        <span
          className={`inline-flex items-center justify-center h-4 w-4 rounded-full text-[10px] font-bold ${icon.color}`}
        >
          {icon.symbol}
        </span>
        <span>{description}</span>
        {actorName && (
          <>
            <span className="text-gray-400">by {actorName}</span>
          </>
        )}
        <span className="text-gray-400">&middot;</span>
        <span className="text-gray-400">{formatEventTime(event.created_at)}</span>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────

export function ActivityTimeline({
  messages,
  events,
  attachments,
  showAttachments = true,
  onTimelineChanged,
}: ActivityTimelineProps) {
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;

  const [lightbox, setLightbox] = useState<{
    url: string;
    attachment: SupportTicketAttachment;
  } | null>(null);

  // Group attachments by message_id
  const attachmentsByMessage = new Map<string, SupportTicketAttachment[]>();
  for (const att of attachments) {
    if (!att.message_id) continue;
    if (!attachmentsByMessage.has(att.message_id)) {
      attachmentsByMessage.set(att.message_id, []);
    }
    attachmentsByMessage.get(att.message_id)!.push(att);
  }

  const timeline = buildTimeline(messages, events);

  function openLightbox(url: string, att: SupportTicketAttachment) {
    setLightbox({ url, attachment: att });
  }

  if (timeline.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400 text-sm">
        No activity yet.
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {timeline.map((entry) => {
          if (entry.type === 'message') {
            const msg = entry.data;
            const msgAttachments = attachmentsByMessage.get(msg.id) || [];
            return (
              <MessageCard
                key={`msg-${msg.id}`}
                message={msg}
                attachments={msgAttachments}
                showAttachments={showAttachments}
                currentUserId={currentUserId}
                onPreview={openLightbox}
                onEdited={onTimelineChanged}
                onDeleted={onTimelineChanged}
              />
            );
          } else {
            return (
              <EventInlineCard key={`evt-${entry.data.id}`} event={entry.data} />
            );
          }
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
