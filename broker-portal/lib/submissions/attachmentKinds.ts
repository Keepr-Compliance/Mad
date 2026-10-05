/**
 * What kind of file an attachment is, and which message each one belongs to.
 *
 * The kind helpers moved here from AttachmentList (BACKLOG-401) unchanged, so
 * the Attachments list and the photos shown inside text bubbles (BACKLOG-3748)
 * classify a file the same way.
 */

export interface AttachmentKindInput {
  filename: string;
  mime_type: string | null;
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

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv', '.3gp'];

export function isMediaFile(attachment: AttachmentKindInput): boolean {
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

export function isVideoFile(attachment: AttachmentKindInput): boolean {
  const mimeType = attachment.mime_type?.toLowerCase() || '';
  const filename = attachment.filename.toLowerCase();

  if (mimeType.startsWith('video/')) return true;

  return VIDEO_EXTENSIONS.some(ext => filename.endsWith(ext));
}

export function isHeicFile(attachment: AttachmentKindInput): boolean {
  const mimeType = attachment.mime_type?.toLowerCase() || '';
  const filename = attachment.filename.toLowerCase();

  return mimeType === 'image/heic' ||
    mimeType === 'image/heif' ||
    filename.endsWith('.heic') ||
    filename.endsWith('.heif');
}

export function formatFileSize(bytes: number | null): string {
  if (!bytes) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The fields the inline viewer needs (a subset of a submission_attachments row). */
export interface MessageAttachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

/**
 * BACKLOG-3748: submission_messages.id -> the files that came with that message.
 *
 * Joined ONLY on submission_attachments.message_id. attachment_count and
 * message_type are not used: on real rows attachment_count is 0 even when
 * has_attachments is true, and photos arrive on 'text' messages too.
 *
 * Only messages passed in are used (the page passes its feature-gated list),
 * and a message's files are included only when its own channel's attachment
 * flag is on: texts need broker_text_attachments, emails need
 * broker_email_attachments.
 */
export function groupAttachmentsByMessage<A extends MessageAttachment & { message_id?: string | null }>(
  attachments: A[],
  messages: { id: string; channel: string | null }[],
  allowed: { text: boolean; email: boolean }
): Record<string, MessageAttachment[]> {
  const channelById = new Map(messages.map((m) => [m.id, m.channel]));
  const out: Record<string, MessageAttachment[]> = {};
  for (const a of attachments) {
    if (!a.message_id || !channelById.has(a.message_id)) continue;
    const isEmail = channelById.get(a.message_id) === 'email';
    if (isEmail ? !allowed.email : !allowed.text) continue;
    const entry: MessageAttachment = {
      id: a.id,
      filename: a.filename,
      mime_type: a.mime_type,
      file_size_bytes: a.file_size_bytes,
      storage_path: a.storage_path,
    };
    (out[a.message_id] ??= []).push(entry);
  }
  return out;
}
