'use client';

/**
 * BACKLOG-3748: the files that came with one text or email, shown inside its
 * bubble in the conversation viewer. Photos are thumbnails, videos a play tile,
 * anything else a compact chip. Clicking any of them opens the existing
 * AttachmentViewerModal (the caller owns it).
 *
 * A photo is signed only once its tile scrolls into view (IntersectionObserver),
 * so opening a long thread does not sign every photo in it. Videos and other
 * files are not signed here at all; the viewer signs on open.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { FileText, ImageOff, Loader2, Play } from 'lucide-react';
import { useAttachmentThumbnailUrl } from './useAttachmentThumbnailUrl';
import { isMediaFile, isVideoFile, type MessageAttachment } from '@/lib/submissions/attachmentKinds';

export const PHOTO_LOAD_FAILED = "Photo couldn't be loaded";

/** true once the element is on screen (or at once where IntersectionObserver does not exist). */
function useInView<T extends Element>(): [RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView]);

  return [ref, inView];
}

function PhotoTile({ attachment, onOpen }: { attachment: MessageAttachment; onOpen: () => void }) {
  const [ref, inView] = useInView<HTMLButtonElement>();
  const { url, loading, error } = useAttachmentThumbnailUrl(attachment, inView);
  const [imgFailed, setImgFailed] = useState(false);
  const failed = error || imgFailed || (!loading && !url && inView);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-label={attachment.filename}
      title={attachment.filename}
      data-testid="inline-photo"
      className="relative block w-48 h-48 max-w-full rounded-xl overflow-hidden bg-gray-200 hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-primary-500"
    >
      {failed ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-center text-gray-500">
          <ImageOff className="w-6 h-6" />
          <span className="text-xs not-italic">{PHOTO_LOAD_FAILED}</span>
        </span>
      ) : url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={attachment.filename}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </span>
      )}
    </button>
  );
}

function VideoTile({ attachment, onOpen }: { attachment: MessageAttachment; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={attachment.filename}
      title={attachment.filename}
      data-testid="inline-video"
      className="relative flex items-center justify-center w-48 h-32 max-w-full rounded-xl overflow-hidden bg-black hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-primary-500"
    >
      <span className="w-12 h-12 bg-white bg-opacity-90 rounded-full flex items-center justify-center">
        <Play className="w-6 h-6 text-gray-900 ml-1" fill="currentColor" />
      </span>
    </button>
  );
}

function FileChip({ attachment, onOpen }: { attachment: MessageAttachment; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={attachment.filename}
      title={attachment.filename}
      data-testid="inline-file"
      className="flex items-center gap-2 max-w-full px-3 py-1.5 rounded-lg bg-white/90 text-gray-800 border border-gray-200 hover:bg-white text-xs not-italic focus:outline-none focus:ring-2 focus:ring-primary-500"
    >
      <FileText className="w-4 h-4 flex-shrink-0 text-gray-500" />
      <span className="truncate">{attachment.filename}</span>
    </button>
  );
}

export function InlineMessageAttachments({
  attachments,
  onOpen,
}: {
  attachments: MessageAttachment[];
  onOpen: (attachment: MessageAttachment) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 mb-1" data-testid="inline-attachments">
      {attachments.map((a) => {
        const open = () => onOpen(a);
        if (!isMediaFile(a)) return <FileChip key={a.id} attachment={a} onOpen={open} />;
        if (isVideoFile(a)) return <VideoTile key={a.id} attachment={a} onOpen={open} />;
        return <PhotoTile key={a.id} attachment={a} onOpen={open} />;
      })}
    </div>
  );
}
