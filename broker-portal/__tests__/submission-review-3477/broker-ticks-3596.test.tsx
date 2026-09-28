/**
 * Broker-owned checklist ticks — BACKLOG-3596, PR 3 (portal).
 *
 * FIXTURE PROVENANCE:
 *   - Status History entries: the jsonb_build_object calls in
 *     carry_submission_checklist_reviews and set_submission_checklist_reviewer_check,
 *     supabase/migrations/20260928120000_backlog_3596_broker_checklist_ticks.sql
 *     (branch feature-portal/BACKLOG-3596-cloud @ b3d0b912d), built through
 *     __tests__/helpers/submissionRows.ts. changed_by is already a display name
 *     here (the pages resolve it before rendering).
 *   - Where the carry-over lines sit: they are appended while the new version
 *     is `uploading` (the snapshot runs before finalize), so they precede the
 *     `resubmitted` status entry finalize produces.
 *   - The missing-column error: transcribed from the live PostgREST API on
 *     2026-09-28, before the 3596 migration was applied:
 *     {"code":"42703","details":null,"hint":null,"message":"column submission_checklist_items.cleared_reviewer_id does not exist"}
 *   - The superseded refusal: `RAISE EXCEPTION 'superseded' USING ERRCODE = '42501'`
 *     (same migration, §5); supabase-js surfaces it as {code, message}.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { StatusHistory } from '@/components/submission/StatusHistory';
import {
  describeTypedEntry,
  withoutBrokerReviewEntries,
  type StatusHistoryEntry,
} from '@/lib/submissions/history';
import { loadSubmissionChecklists } from '@/lib/submissions/checklists';
import { REVIEW_MESSAGES, reasonForReviewRpcError, reviewFailure } from '@/lib/submissions/reviewMessages';
import {
  checklistAddedEntry,
  checklistReviewClearedEntry,
  checklistReviewEntry,
  checklistReviewUnavailableEntry,
} from '../helpers/submissionRows';
import type { SupabaseClient } from '@supabase/supabase-js';

const AGENT = 'Agent Fixture';
const CONTRACT = 'Purchase Contract';
const BROKER = 'Broker Fixture';

const cleared = (reason: 'edited' | 'removed', title: string, at: string, changedBy: string | null = AGENT) =>
  ({
    ...checklistReviewClearedEntry({
      changedBy: 'x',
      reason,
      itemId: reason === 'removed' ? null : 'item-v2',
      clearedFromItemId: 'item-v1',
      itemTitle: title,
      checklistName: CONTRACT,
      clearedReviewerId: 'broker-id',
      clearedReviewerCheckedAt: '2026-09-01T01:00:00Z',
      changedAt: at,
    }),
    changed_by: changedBy,
  }) as unknown as StatusHistoryEntry;

const unavailable = (reason: 'unmatched_client' | 'no_previous_copy' | undefined, at = '2026-09-02T00:00:02Z') => {
  const e: Record<string, unknown> = {
    ...checklistReviewUnavailableEntry({ changedBy: 'x', reason: 'unmatched_client', changedAt: at }),
    changed_by: AGENT,
  };
  if (reason) e.reason = reason;
  else delete e.reason;
  return e as unknown as StatusHistoryEntry;
};

describe('Status History labels (BACKLOG-3596, P-C5)', () => {
  it('an automatic untick names the item and the agent who changed it', () => {
    expect(describeTypedEntry(cleared('edited', 'Executed contract', '2026-09-02T00:00:00Z'))).toBe(
      'Executed contract — unticked automatically: changed by Agent Fixture since your check'
    );
  });

  it('an item the agent removed says removed', () => {
    expect(describeTypedEntry(cleared('removed', 'Addenda', '2026-09-02T00:00:00Z'))).toBe(
      'Addenda — unticked automatically: removed by Agent Fixture since your check'
    );
  });

  it('names unavailable: "the agent", never a raw id', () => {
    expect(describeTypedEntry(cleared('edited', 'Executed contract', '2026-09-02T00:00:00Z', null))).toBe(
      'Executed contract — unticked automatically: changed by the agent since your check'
    );
  });

  it.each([
    ['unmatched_client', 'Previous review marks could not be carried over (the agent sent it from an older version of Keepr)'],
    ['no_previous_copy', 'Previous review marks could not be carried over (the previous version’s checklists were not saved)'],
    [undefined, 'Previous review marks could not be carried over'],
  ] as const)('marks not carried over, cause %s', (reason, text) => {
    expect(describeTypedEntry(unavailable(reason))).toBe(text);
  });

  it('none of the typed entries the system writes reads "Submission updated"', () => {
    const all: StatusHistoryEntry[] = [
      checklistReviewEntry({ changedBy: BROKER, itemId: 'i', itemTitle: 'A', checklistName: 'C', from: false, to: true }) as unknown as StatusHistoryEntry,
      checklistAddedEntry({ changedBy: BROKER, checklistId: 'h', checklistName: 'C', templateId: 't' }) as unknown as StatusHistoryEntry,
      cleared('edited', 'A', '2026-09-02T00:00:00Z'),
      cleared('removed', 'A', '2026-09-02T00:00:00Z'),
      unavailable('unmatched_client'),
      unavailable('no_previous_copy'),
    ];
    for (const e of all) expect(describeTypedEntry(e)).not.toBe('Submission updated');
  });
});

describe('carry-over lines in the broker timeline (P-C5)', () => {
  // v1 then v2, merged oldest-first as submissions/[id]/page.tsx does.
  const HISTORY: StatusHistoryEntry[] = [
    { status: 'under_review', changed_at: '2026-09-01T00:30:00Z', changed_by: undefined, notes: null },
    checklistReviewEntry({ changedBy: BROKER, itemId: 'item-v1', itemTitle: 'Executed contract', checklistName: CONTRACT, from: false, to: true, changedAt: '2026-09-01T01:00:00Z' }) as unknown as StatusHistoryEntry,
    { status: 'needs_changes', changed_at: '2026-09-01T02:00:00Z', changed_by: BROKER, notes: 'Please fix' },
    cleared('edited', 'Executed contract', '2026-09-02T00:00:00Z'),
    unavailable('no_previous_copy', '2026-09-02T00:00:01Z'),
    { status: 'resubmitted', changed_at: '2026-09-02T00:01:00Z', changed_by: undefined, notes: null, parentSubmissionId: 'v1' },
  ];

  function renderTimeline() {
    const view = render(<StatusHistory history={HISTORY} currentStatus="resubmitted" submittedAt="2026-09-01T00:00:00Z" />);
    for (const b of Array.from(view.container.querySelectorAll('[data-testid="checklist-changes-group"] > button'))) fireEvent.click(b);
    return view;
  }

  it('group under "Resubmitted" as checklist changes, never as a status line, never Current', () => {
    const { container } = renderTimeline();
    const resubmitted = screen.getByText('Resubmitted').closest('li')!;
    const lines = Array.from(resubmitted.querySelectorAll('[data-testid="typed-history-entry"]'));
    expect(lines.map((l) => l.getAttribute('data-entry-type'))).toEqual(['checklist_review_cleared', 'checklist_review_unavailable']);
    expect(lines[0]).toHaveTextContent('Executed contract — unticked automatically: changed by Agent Fixture since your check');
    expect(lines[0]).toHaveTextContent('Purchase Contract');
    // The sentence names the agent; no second "by" line under it.
    expect(lines[0].textContent).not.toMatch(/\bby Agent Fixture\b.*\bby Agent Fixture\b/);
    expect(lines[0].querySelector('p.text-xs.text-gray-500')).toBeNull();
    for (const l of lines) expect(l).not.toHaveTextContent('Current');
    expect(screen.getByText('Current').closest('li')).toBe(resubmitted);
    expect(container.textContent).not.toContain('Submission updated');
    // Status labels are untouched by the new lines.
    expect(container.textContent).not.toMatch(/checklist_review/);
  });
});

describe('withoutBrokerReviewEntries (D4)', () => {
  it('drops exactly the three broker review types and keeps order', () => {
    const input: StatusHistoryEntry[] = [
      { status: 'submitted', changed_at: '1' },
      checklistReviewEntry({ changedBy: BROKER, itemId: 'i', itemTitle: 'A', checklistName: 'C', from: false, to: true }) as unknown as StatusHistoryEntry,
      checklistAddedEntry({ changedBy: BROKER, checklistId: 'h', checklistName: 'C', templateId: 't' }) as unknown as StatusHistoryEntry,
      cleared('edited', 'A', '2'),
      unavailable('unmatched_client'),
      { status: 'resubmitted', changed_at: '3' },
    ];
    expect(withoutBrokerReviewEntries(input).map((e) => e.type ?? e.status)).toEqual(['submitted', 'checklist_added', 'resubmitted']);
  });
});

describe('superseded refusal copy', () => {
  it('42501 superseded maps to plain words, not the permission copy', () => {
    const reason = reasonForReviewRpcError({ code: '42501', message: 'superseded' });
    expect(reason).toBe('superseded');
    expect(reviewFailure(reason).message).toBe(
      'A newer version of this submission has been sent, so this version is closed. Check items on the newest version.'
    );
    expect(REVIEW_MESSAGES.superseded).not.toBe(REVIEW_MESSAGES.not_authorized);
  });
});

/**
 * The portal ships before the 3596 migration (release order C-11). Reading the
 * cleared columns must not break the section on a database without them.
 */
describe('loadSubmissionChecklists with and without the 3596 columns', () => {
  const ITEM_BASE = {
    id: 'item-1',
    submission_checklist_id: 'hdr-1',
    title: 'Executed contract',
    description: null,
    is_required: true,
    is_checked: true,
    note: null,
    sort_order: 0,
    reviewer_checked: false,
    reviewer_checked_by: null,
    reviewer_checked_at: null,
  };
  const HEADER = { id: 'hdr-1', template_id: 'tpl-1', template_name: 'Purchase Contract', sort_order: 0, added_at_review_by: null, added_at_review_at: null };
  const MISSING = { code: '42703', details: null, hint: null, message: 'column submission_checklist_items.cleared_reviewer_id does not exist' };

  function fakeClient(itemsAnswer: (columns: string) => { data: unknown; error: unknown }) {
    const itemSelects: string[] = [];
    const client = {
      from(table: string) {
        return {
          select(columns: string) {
            if (table === 'submission_checklist_items') itemSelects.push(columns);
            return {
              eq: async () => {
                if (table === 'submission_checklists') return { data: [HEADER], error: null };
                if (table === 'submission_checklist_items') return itemsAnswer(columns);
                return { data: [], error: null };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;
    return { client, itemSelects };
  }

  it('migration applied: the cleared columns are read and mapped', async () => {
    const { client, itemSelects } = fakeClient(() => ({
      data: [{ ...ITEM_BASE, cleared_reviewer_id: 'broker-id', cleared_at: '2026-09-02T00:00:00Z' }],
      error: null,
    }));
    const r = await loadSubmissionChecklists(client, 'sub-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections[0].items[0]).toMatchObject({ clearedReviewerId: 'broker-id', clearedAt: '2026-09-02T00:00:00Z' });
    expect(itemSelects).toHaveLength(1);
    expect(itemSelects[0]).toContain('cleared_reviewer_id');
  });

  it('migration not applied: one retry without the columns, section loads, nothing cleared', async () => {
    const { client, itemSelects } = fakeClient((columns) =>
      columns.includes('cleared_') ? { data: null, error: MISSING } : { data: [ITEM_BASE], error: null }
    );
    const r = await loadSubmissionChecklists(client, 'sub-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections[0].items[0]).toMatchObject({ title: 'Executed contract', clearedReviewerId: null, clearedAt: null });
    expect(itemSelects).toHaveLength(2);
    expect(itemSelects[1]).not.toContain('cleared_');
  });

  it('any other error still fails the whole section (no silent retry)', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { client, itemSelects } = fakeClient(() => ({ data: null, error: { code: '42501', message: 'permission denied' } }));
    expect((await loadSubmissionChecklists(client, 'sub-1')).ok).toBe(false);
    expect(itemSelects).toHaveLength(1);
    quiet.mockRestore();
  });
});
