/**
 * BACKLOG-3893 — the top loading bar appears in the same click that starts an
 * in-app navigation, and goes away when the URL changes.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

let mockPathname = '/dashboard';
jest.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

import { NavigationProgress, SAFETY_MS } from '@/components/pwa/NavigationProgress';

function App() {
  return (
    <>
      <NavigationProgress />
      <a href="/dashboard/submissions">
        <span>Submissions</span>
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
  jest.useFakeTimers();
  mockPathname = '/dashboard';
  window.history.replaceState(null, '', '/dashboard');
  window.addEventListener('click', cancelNav);
});
afterEach(() => {
  cleanup();
  window.removeEventListener('click', cancelNav);
  jest.useRealTimers();
});

const bar = () => screen.queryByTestId('nav-progress');

describe('BACKLOG-3893 NavigationProgress', () => {
  it('renders nothing when idle', () => {
    render(<App />);
    expect(bar()).toBeNull();
  });

  it('a plain click on an in-app link shows the bar in the same click, before any server answer', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Submissions'));
    expect(bar()?.getAttribute('data-state')).toBe('loading');
  });

  it('the bar finishes when the pathname changes, then disappears', () => {
    const { rerender } = render(<App />);
    fireEvent.click(screen.getByText('Submissions'));
    mockPathname = '/dashboard/submissions';
    rerender(<App />);
    expect(bar()?.getAttribute('data-state')).toBe('done');
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(bar()).toBeNull();
  });

  it('a query-only URL change (no pathname change) also finishes the bar', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Submissions'));
    act(() => {
      window.history.pushState(null, '', '/dashboard?tab=2');
      jest.advanceTimersByTime(150);
    });
    expect(bar()?.getAttribute('data-state')).toBe('done');
  });

  it('back/forward (popstate) finishes the bar', () => {
    render(<App />);
    fireEvent.click(screen.getByText('Submissions'));
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(bar()?.getAttribute('data-state')).toBe('done');
  });

  it(`a navigation that never lands stops after ${SAFETY_MS} ms`, () => {
    render(<App />);
    fireEvent.click(screen.getByText('Submissions'));
    act(() => {
      jest.advanceTimersByTime(SAFETY_MS - 1);
    });
    expect(bar()?.getAttribute('data-state')).toBe('loading');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(bar()?.getAttribute('data-state')).toBe('done');
  });

  it.each([
    ['the page already open', 'Same page', {}],
    ['a hash-only link', 'Hash', {}],
    ['another origin', 'External', {}],
    ['target=_blank', 'New tab', {}],
    ['a download link', 'Download', {}],
    ['a cmd/ctrl-click', 'Submissions', { metaKey: true }],
    ['a middle click', 'Submissions', { button: 1 }],
  ])('does not start for %s', (_label, text, init) => {
    render(<App />);
    fireEvent.click(screen.getByText(text), init);
    expect(bar()).toBeNull();
  });

  it('does not start for a click something else already cancelled', () => {
    render(<App />);
    const link = screen.getByText('Submissions');
    link.addEventListener('click', (e) => e.preventDefault());
    fireEvent.click(link);
    expect(bar()).toBeNull();
  });
});
