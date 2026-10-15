'use client';

import { useEffect } from 'react';

/**
 * Registers /sw.js (BACKLOG-3797). Renders nothing.
 *
 * Production only. In development it unregisters any worker left on the dev
 * origin instead, so a stale worker never sits between the developer and the
 * dev server.
 */
export function ServiceWorkerRegister(): null {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => registrations.forEach((r) => r.unregister()))
        .catch(() => undefined);
      return;
    }

    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch((error: unknown) => {
        // Private browsing and some embedded browsers refuse registration;
        // the portal works the same without it.
        console.warn('[pwa] service worker registration failed', error);
      });
  }, []);

  return null;
}

export default ServiceWorkerRegister;
