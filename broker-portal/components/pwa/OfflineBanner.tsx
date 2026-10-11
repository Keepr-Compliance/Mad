'use client';

import { useEffect, useState } from 'react';

/**
 * In-place offline notice (BACKLOG-3797; broker port BACKLOG-3893). Shown while the browser reports no
 * connection; the page that is already on screen stays as it is. Hidden again
 * on the `online` event.
 *
 * Renders nothing until mounted, so server and client HTML always match.
 * Fixed to the bottom edge (above the iPhone home indicator) so it never
 * covers the phone top bar. The service worker's offline screen is only for a
 * full page load that fails with no network.
 */
export function OfflineBanner(): JSX.Element | null {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pointer-events-none"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
    >
      <p className="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white shadow-lg">
        You&apos;re offline. Showing the last loaded page.
      </p>
    </div>
  );
}

export default OfflineBanner;
