/**
 * BACKLOG-3893 (port of admin BACKLOG-3797) — tapping a submissions row
 * (router.push, not an <a>) starts the top loading bar; and
 * app/dashboard/loading.tsx exists and renders a static skeleton.
 *
 * SubmissionRow is the only row in the broker portal that navigates with
 * router.push (app/dashboard/submissions/page.tsx renders it). User rows and
 * user cards navigate through a next/link <a>, which the bar's own
 * anchor-click listener already covers.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { existsSync } from 'fs';
import { resolve } from 'path';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  usePathname: () => '/dashboard/submissions',
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
}));

import { NavigationProgress } from '@/components/pwa/NavigationProgress';
import { SubmissionRow } from '@/components/submission/SubmissionRow';
import DashboardLoading from '@/app/dashboard/loading';

function Table() {
  return (
    <>
      <NavigationProgress />
      <table>
        <tbody>
          <SubmissionRow href="/dashboard/submissions/sub-1">
            <td>123 Main St</td>
            <td>
              <button type="button">Menu</button>
            </td>
          </SubmissionRow>
        </tbody>
      </table>
    </>
  );
}

const bar = () => screen.queryByTestId('nav-progress');

afterEach(() => {
  cleanup();
  mockPush.mockClear();
});

describe('BACKLOG-3893 row taps start the loading bar', () => {
  it('tapping a submissions row shows the bar in the same event as router.push', () => {
    render(<Table />);
    expect(bar()).toBeNull();
    fireEvent.click(screen.getByText('123 Main St'));
    expect(mockPush).toHaveBeenCalledWith('/dashboard/submissions/sub-1');
    expect(bar()?.getAttribute('data-state')).toBe('loading');
  });

  it('a tap on a control inside the row neither navigates nor starts the bar', () => {
    render(<Table />);
    fireEvent.click(screen.getByText('Menu'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(bar()).toBeNull();
  });

  it('cmd-click opens a new tab and does not start the bar', () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    render(<Table />);
    fireEvent.click(screen.getByText('123 Main St'), { metaKey: true });
    expect(open).toHaveBeenCalledWith('/dashboard/submissions/sub-1', '_blank', 'noopener');
    expect(mockPush).not.toHaveBeenCalled();
    expect(bar()).toBeNull();
    open.mockRestore();
  });
});

describe('BACKLOG-3893 app/dashboard/loading.tsx', () => {
  it('exists and renders a status skeleton without data fetching', () => {
    expect(existsSync(resolve(__dirname, '../../app/dashboard/loading.tsx'))).toBe(true);
    render(<DashboardLoading />);
    const el = screen.getByTestId('dashboard-loading');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-busy')).toBe('true');
  });
});
