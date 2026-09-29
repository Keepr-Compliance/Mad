/**
 * Checklist template list — "Last edited" time (BACKLOG-3474 PR 4).
 *
 * ChecklistsListClient renders date-only on first paint (server can't know
 * the viewer's timezone) and switches to date + time once mounted in the
 * browser. RTL's render() flushes that mount effect, so these assertions
 * see the final, timed state — same reasoning as editor.test.tsx's audit
 * line tests.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRefresh = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));
jest.mock('@/lib/actions/checklists', () => ({
  archiveChecklistTemplate: jest.fn(),
  restoreChecklistTemplate: jest.fn(),
}));

import { renderToStaticMarkup } from 'react-dom/server';
import ChecklistsListClient from '@/app/dashboard/checklists/ChecklistsListClient';
import type { ChecklistListRow } from '@/lib/checklists/listRows';

const UPDATED_AT = '2026-09-24T22:08:43.723274+00:00';

// process.env.TZ is pinned to a non-UTC zone in jest.config.js (NOT here — a
// per-test process.env.TZ assignment has no effect, verified empirically;
// see editor.test.tsx for detail — the mechanism inside jest is not traced).
// Pinning proves a real local-time conversion happened, not just "some time
// string is present".
/** Same recipe as formatAuditDateTime (lib/checklists/audit.ts), recomputed
 *  independently so this also catches a bug inside the formatter itself. */
function dt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

const row: ChecklistListRow = {
  id: '00000000-0000-4000-8000-0000003474b1', // pii-allow-uuid: invented fixture id, not from any live row
  name: 'Residential purchase',
  description: null,
  seeded: false,
  archived: false,
  updatedAt: UPDATED_AT,
  updatedBy: 'Jane Doe',
  itemCount: 3,
  requiredCount: 2,
};

describe('ChecklistsListClient — last edited time', () => {
  it('shows the date and time once mounted', () => {
    render(<ChecklistsListClient rows={[row]} />);
    expect(screen.getByTestId('checklist-row')).toHaveTextContent(dt(UPDATED_AT));
    expect(screen.getByText('by Jane Doe')).toBeInTheDocument();
  });

  // Pins the mount gate itself: renderToStaticMarkup never runs effects, so
  // this is exactly what the server sends before the browser mounts. If the
  // `mounted` state were ever initialized to true (or the gate removed), the
  // server markup would already contain a time computed in the SERVER's
  // timezone (UTC on Vercel) — the bug the mount gate exists to prevent.
  it('renders date-only server-side, before the mount effect can run', () => {
    const html = renderToStaticMarkup(<ChecklistsListClient rows={[row]} />);
    expect(html).toContain('Sep 24, 2026');
    expect(html).not.toContain(dt(UPDATED_AT));
  });
});
