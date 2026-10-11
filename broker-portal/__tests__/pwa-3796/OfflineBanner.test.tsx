/**
 * BACKLOG-3893 (port of admin BACKLOG-3797) — the in-place offline banner follows navigator.onLine and the
 * online/offline events, and renders nothing while online.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { OfflineBanner } from '@/components/pwa/OfflineBanner';

const TEXT = "You're offline. Showing the last loaded page.";
let onLine = true;
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => onLine });

function goOffline() {
  onLine = false;
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
}
function goOnline() {
  onLine = true;
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
}

afterEach(() => {
  cleanup();
  onLine = true;
});

describe('BACKLOG-3893 OfflineBanner', () => {
  it('online at load: renders nothing', () => {
    const { container } = render(<OfflineBanner />);
    expect(container.innerHTML).toBe('');
  });

  it('offline at load (navigator.onLine false): shows the banner as a polite status', () => {
    onLine = false;
    render(<OfflineBanner />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(TEXT);
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('shows on the offline event and hides on the online event', () => {
    const { container } = render(<OfflineBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    goOffline();
    expect(screen.getByRole('status').textContent).toBe(TEXT);
    goOnline();
    expect(container.innerHTML).toBe('');
  });

  it('stops listening after unmount', () => {
    const { unmount } = render(<OfflineBanner />);
    unmount();
    goOffline();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
