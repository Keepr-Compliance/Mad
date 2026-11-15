'use client';

/**
 * Stops browser session replay for the rest of this page load without sending
 * what it buffered (BACKLOG-4259). Rendered by the pages that
 * lib/sentry/replayRoutes.ts excludes, for when they are reached by
 * client-side navigation.
 */

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

export function ReplayOff() {
  useEffect(() => {
    try {
      void Sentry.getReplay()?.stop({ flush: false });
    } catch {
      // replay is optional; the page must render without it
    }
  }, []);
  return null;
}
