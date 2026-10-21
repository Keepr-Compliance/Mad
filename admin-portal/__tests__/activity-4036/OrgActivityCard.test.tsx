// @vitest-environment jsdom
/**
 * BACKLOG-4036: the Activity card. Five rows, then "Show more"; empty state; the Keepr badge on
 * staff rows.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OrgActivityCard } from '@/app/dashboard/organizations/[id]/components/OrgActivityCard';
import type { ActivityRow } from '@/lib/activity/describeActivity';

function rows(n: number): ActivityRow[] {
  return Array.from({ length: n }, (_, i) => ({
    action: 'member_invited',
    detail: { role: 'agent' },
    actor_name: 'Pat Doe',
    created_at: `2026-10-21T16:${String(59 - i).padStart(2, '0')}:00+00:00`,
    subject_name: `Person ${i + 1}`,
    actor_is_staff: false,
    actor_is_subject: false,
  }));
}

afterEach(cleanup);

describe('OrgActivityCard (BACKLOG-4036)', () => {
  it('shows five rows, then the rest after Show more, and back with Show fewer', () => {
    render(<OrgActivityCard rows={rows(7)} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Showing 5 of 7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByText('Pat Doe invited Person 7')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('has no Show more with five rows or fewer', () => {
    render(<OrgActivityCard rows={rows(5)} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the empty state with no rows', () => {
    render(<OrgActivityCard rows={[]} />);
    expect(screen.getByText('No activity yet.')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('shows an error, not the empty state, when the reader failed', () => {
    render(<OrgActivityCard rows={[]} failed />);
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load activity.");
    expect(screen.queryByText('No activity yet.')).toBeNull();
  });

  it('marks staff rows with a Keepr badge and shows the note', () => {
    render(
      <OrgActivityCard
        rows={[{ ...rows(1)[0], action: 'suspended', actor_is_staff: true, detail: { note: 'Card declined' } }, rows(1)[0]]}
      />
    );
    expect(screen.getAllByText('Keepr')).toHaveLength(1);
    expect(screen.getByText('— Card declined')).toBeTruthy();
    expect(screen.getByText('Pat Doe suspended the organization')).toBeTruthy();
  });
});
