'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Thin top loading bar for in-app navigation (BACKLOG-3797).
 *
 * Starts in the same click event that begins a Next <Link> navigation, so
 * there is visible feedback on the next frame, before the server answers.
 * Stops when the URL changes (pathname via usePathname, query via a 100 ms
 * check of location.href while loading), on back/forward, or after SAFETY_MS.
 *
 * Starts only for a plain left click on a same-origin link to a different
 * path or query: not for modified clicks, new-tab/download links, hash-only
 * links, or the page already open. No dependency; renders nothing when idle.
 */
export const SAFETY_MS = 8000;
const URL_CHECK_MS = 100;

const KEYFRAMES =
  '@keyframes keepr-nav-progress{from{width:15%}to{width:85%}}';

export function shouldStartFor(event: MouseEvent, current: Location): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target as Element | null;
  const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
  if (!anchor) return false;
  if (anchor.hasAttribute('download')) return false;
  const t = anchor.getAttribute('target');
  if (t && t !== '_self') return false;
  let url: URL;
  try {
    url = new URL((anchor as HTMLAnchorElement).href, current.href);
  } catch {
    return false;
  }
  if (url.origin !== current.origin) return false;
  return url.pathname + url.search !== current.pathname + current.search;
}

export function NavigationProgress(): JSX.Element | null {
  const pathname = usePathname();
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  const finish = () => {
    clearTimers();
    setState((s) => (s === 'loading' ? 'done' : s));
    timers.current.push(setTimeout(() => setState('idle'), 250));
  };

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!shouldStartFor(event, window.location)) return;
      clearTimers();
      setState('loading');
      const startHref = window.location.href;
      timers.current.push(setTimeout(finish, SAFETY_MS));
      const poll = () => {
        if (window.location.href !== startHref) finish();
        else timers.current.push(setTimeout(poll, URL_CHECK_MS));
      };
      timers.current.push(setTimeout(poll, URL_CHECK_MS));
    };
    // Bubble phase on document: runs after Link's own onClick, so
    // event.defaultPrevented reflects anything that cancelled the click.
    document.addEventListener('click', onClick);
    window.addEventListener('popstate', finish);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('popstate', finish);
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (state === 'idle') return null;

  return (
    <div
      data-testid="nav-progress"
      data-state={state}
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5"
    >
      <style>{KEYFRAMES}</style>
      <div
        className="h-full bg-blue-500"
        style={
          state === 'loading'
            ? { width: '85%', animation: `keepr-nav-progress ${SAFETY_MS}ms cubic-bezier(0.1, 0.7, 0.2, 1)` }
            : { width: '100%', opacity: 0, transition: 'opacity 200ms ease-in 50ms' }
        }
      />
    </div>
  );
}

export default NavigationProgress;
