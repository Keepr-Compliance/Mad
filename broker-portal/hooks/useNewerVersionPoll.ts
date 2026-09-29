'use client';

/**
 * BACKLOG-3605: notice a newer version of the submission being reviewed.
 *
 * Every 30 s while the tab is visible, reads whether a newer version of
 * `currentId` exists, with the SAME rule the server page uses
 * (walkNewer in lib/submissions/versions.ts: a child that is not still
 * uploading). Reads with the broker's own browser session, so the same
 * SELECT policy that decides who can open the page decides what the poll sees.
 *
 * - Hidden tab: no reads. Back to visible: one read at once, then every 30 s.
 * - A hit: returns the newest version and stops polling for good.
 * - A failed read: no hit, keep polling. No toast.
 * - One read at a time; a read that answers after the effect ended (unmount,
 *   a different page, polling switched off) is ignored.
 */

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { walkNewer, type VersionLink } from '@/lib/submissions/versions';

export const NEWER_VERSION_POLL_MS = 30_000;

interface Options {
  /** The version being viewed. */
  currentId: string;
  /** Position of the version being viewed in its chain (1 = the first). */
  currentPosition: number;
  /** False: no reads at all (support session, or the server already knows). */
  enabled: boolean;
}

export function useNewerVersionPoll({ currentId, currentPosition, enabled }: Options): VersionLink | null {
  const [found, setFound] = useState<VersionLink | null>(null);
  const clientRef = useRef<ReturnType<typeof createClient> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let done = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer === null && !done && !cancelled) timer = setInterval(check, NEWER_VERSION_POLL_MS);
    };

    async function check(): Promise<void> {
      if (cancelled || done || inFlight) return;
      if (document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        clientRef.current ??= createClient();
        const newer = await walkNewer(clientRef.current, currentId);
        if (cancelled || done) return;
        if (newer.length > 0) {
          done = true;
          stop();
          const row = newer[newer.length - 1];
          setFound({
            id: row.id,
            number: row.version ?? currentPosition + newer.length,
            status: row.status,
            createdAt: row.created_at,
          });
        }
      } catch {
        // A failed read is not a newer version; the next tick asks again.
      } finally {
        inFlight = false;
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void check();
        start();
      } else {
        stop();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') start();

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [currentId, currentPosition, enabled]);

  return found;
}
