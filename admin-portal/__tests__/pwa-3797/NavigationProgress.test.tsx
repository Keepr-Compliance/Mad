// @vitest-environment jsdom
/**
 * BACKLOG-3797 — the top loading bar appears in the same click that starts an
 * in-app navigation, and goes away when the URL changes.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { NavigationProgress, SAFETY_MS } from '@/components/pwa/NavigationProgress';

function App() {
  return (
    <>
      <NavigationProgress />
      <a href="/dashboard/support">
        <span>Support</span>
      </a>
      <a href="/dashboard">Same page</a>
      <a href="#top">Hash</a>
      <a href="https://elsewhere.example.test/x">External</a>
      <a href="/dashboard/users" target="_blank">New tab</a>
      <a href="/files/report.csv" download>
        Download
      </a>
    </>
  );
}

// jsdom would try to navigate on an anchor click; cancel that AFTER the
// component's bubble-phase listener has run (window is after document).
const cancelNav = (e: Event) => e.preventDefault();

beforeEach(() => {
  vi.useFakeTimers();
  pathname = '/dashboard';
  window.history.replaceState(null, '', '/dashboard');
  window.addEventListener('click', cancelNav);
});
afterEach(() => {
  cleanup();
  window.removeEventListener('click', cancelNav);
  vi.useRealTimers();
});

const bar = () => screen.queryByTestId('nav-progress');

describe('BACKLOG-3797 NavigationProgress', () => {
  it('renders nothing when idle', () => {
    render(<App />);
    expect(bar()).toBeNull();
  });

  it('a plain click on an in-app link shows the bar in the same click, before any server answer', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Support'));
    expect(bar()?.getAttribute('data-state')).toBe('loading');
  });

  it('the bar finishes when the pathname changes, then disappears', () => {
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByText('Support'));
    pathname = '/dashboard/support';
    rerender(<App />);
    expect(bar()?.getAttribute('data-state')).toBe('done');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(bar()).toBeNull();
  });

  it('a query-only URL change (no pathname change) also finishes the bar', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Support'));
    act(() => {
      window.history.pushState(null, '', '/dashboard?tab=2');
      vi.advanceTimersByTime(150);
    });
    expect(bar()?.getAttribute('data-state')).toBe('done');
  });

  it('back/forward (popstate) finishes the bar', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Support'));
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(bar()?.getAttribute('data-state')).toBe('done');
  });

  it(`a navigation that never lands stops after ${SAFETY_MS} ms`, () => {
    render(<App />);
    fireEvent.click(screen.getByText('Support'));
    act(() => {
      vi.advanceTimersByTime(SAFETY_MS - 1);
    });
    expect(bar()?.getAttribute('data-state')).toBe('loading');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(bar()?.getAttribute('data-state')).toBe('done');
  });

  it.each([
    ['the page already open', 'Same page', {}],
    ['a hash-only link', 'Hash', {}],
    ['another origin', 'External', {}],
    ['target=_blank', 'New tab', {}],
    ['a download link', 'Download', {}],
    ['a cmd/ctrl-click', 'Support', { metaKey: true }],
    ['a middle click', 'Support', { button: 1 }],
  ])('does not start for %s', (_label, text, init) => {
    render(<App />);
    fireEvent.click(screen.getByText(text), init);
    expect(bar()).toBeNull();
  });

  it('does not start for a click something else already cancelled', () => {
    render(<App />);
    const link = screen.getByText('Support');
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);
    expect(bar()).toBeNull();
  });
});
