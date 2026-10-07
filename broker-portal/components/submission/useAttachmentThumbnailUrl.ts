'use client';

/**
 * Signed thumbnail URL for one submission attachment, with HEIC converted to a
 * JPEG object URL. Extracted from AttachmentList's MediaThumbnail (BACKLOG-401)
 * so the photos inside text bubbles (BACKLOG-3748) sign the same way, against
 * the same bucket and expiry.
 *
 * `enabled` = false signs nothing; the inline bubbles pass true only once the
 * tile scrolls into view, so opening a long thread does not sign every photo.
 */

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { isHeicFile } from '@/lib/submissions/attachmentKinds';

export interface ThumbnailAttachment {
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
}

export function useAttachmentThumbnailUrl(
  attachment: ThumbnailAttachment,
  enabled = true
): { url: string | null; loading: boolean; error: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const supabase = useMemo(() => createClient(), []);
  const isHeic = isHeicFile(attachment);
  const { storage_path: storagePath, filename } = attachment;

  useEffect(() => {
    if (!enabled) return;
    if (!storagePath) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    const fetchUrl = async () => {
      try {
        const { data, error: storageError } = await supabase.storage
          .from('submission-attachments')
          .createSignedUrl(storagePath, 3600);

        if (storageError) throw storageError;

        // Convert HEIC to displayable format
        if (isHeic) {
          try {
            const response = await fetch(data.signedUrl);
            const blob = await response.blob();
            // Loaded on demand: heic2any starts a Web Worker when imported, and
            // most threads have no HEIC at all.
            const { default: heic2any } = await import('heic2any');
            const convertedBlob = await heic2any({
              blob,
              toType: 'image/jpeg',
              quality: 0.7, // Lower quality for thumbnails
            });
            const resultBlob = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
            objectUrl = URL.createObjectURL(resultBlob);
            // A conversion that resolves after unmount: the cleanup below already
            // ran (objectUrl was still null then), so nothing would ever revoke
            // this one. Revoke it here instead of handing it to state.
            if (cancelled) {
              URL.revokeObjectURL(objectUrl);
            } else {
              setUrl(objectUrl);
            }
          } catch (conversionError) {
            console.error('HEIC thumbnail conversion failed:', conversionError);
            if (!cancelled) setError(true);
          }
        } else if (!cancelled) {
          setUrl(data.signedUrl);
        }
      } catch (err) {
        console.error('Failed to load attachment thumbnail:', {
          filename,
          storagePath,
          error: err instanceof Error ? err.message : err,
        });
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchUrl();

    // Cleanup object URL on unmount
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, storagePath, filename, supabase, isHeic]);

  return { url, loading, error };
}
