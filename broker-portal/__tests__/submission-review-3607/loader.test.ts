/**
 * Loader fallback when the 3607 migration is not applied — BACKLOG-3607, PR 3.
 *
 * The missing-column error: the shape transcribed from the live PostgREST API
 * on 2026-09-28 by BACKLOG-3596 (__tests__/submission-review-3477/broker-ticks-3596.test.tsx
 * header), {"code":"42703","details":null,"hint":null,"message":"column <table>.<column> does not exist"},
 * with the 3607 column names substituted. Not re-transcribed: production is read
 * only for this task, and a failing SELECT would be needed to produce it.
 *
 * @jest-environment node
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadSubmissionChecklists } from '@/lib/submissions/checklists';

type Db = { has3596: boolean; has3607: boolean; otherError?: boolean };

const HEADER = {
  id: 'hdr-1',
  template_id: 'tpl-1',
  template_name: 'Purchase Contract',
  sort_order: 0,
  added_at_review_by: null,
  added_at_review_at: null,
};
const ITEM = {
  id: 'item-1',
  submission_checklist_id: 'hdr-1',
  title: 'Executed contract',
  description: null,
  is_required: true,
  is_checked: false,
  note: null,
  sort_order: 0,
  reviewer_checked: false,
  reviewer_checked_by: null,
  reviewer_checked_at: null,
};

function client(db: Db, selects: string[]): SupabaseClient {
  return {
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: async () => {
          selects.push(`${table}: ${cols}`);
          const missing = (col: string) => ({
            data: null,
            error: { code: '42703', details: null, hint: null, message: `column ${table}.${col} does not exist` },
          });
          if (db.otherError && table === 'submission_checklists') return { data: null, error: { code: 'XX000', message: 'boom' } };
          if (table === 'submission_checklists') {
            if (!db.has3607 && cols.includes('removed_at_review_by')) return missing('removed_at_review_by');
            return {
              data: [db.has3607 ? { ...HEADER, removed_at_review_by: 'b', removed_at_review_at: 't', restored_from_checklist_id: null } : HEADER],
              error: null,
            };
          }
          if (table === 'submission_checklist_items') {
            if (!db.has3596 && cols.includes('cleared_reviewer_id')) return missing('cleared_reviewer_id');
            if (!db.has3607 && cols.includes('restored_from_item_id')) return missing('restored_from_item_id');
            return { data: [ITEM], error: null };
          }
          return { data: [], error: null };
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('loadSubmissionChecklists without the 3607 migration', () => {
  it('3596 applied, 3607 not: loads, keeps the cleared columns, no removal fields', async () => {
    const selects: string[] = [];
    const r = await loadSubmissionChecklists(client({ has3596: true, has3607: false }, selects), 'sub-1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0]).not.toHaveProperty('removedAtReviewBy');
    const itemSelects = selects.filter((s) => s.startsWith('submission_checklist_items'));
    expect(itemSelects[itemSelects.length - 1]).toContain('cleared_reviewer_id');
    expect(itemSelects[itemSelects.length - 1]).not.toContain('restored_from_item_id');
  });

  it('neither applied: loads with the base columns', async () => {
    const r = await loadSubmissionChecklists(client({ has3596: false, has3607: false }, []), 'sub-1');
    expect(r.ok).toBe(true);
  });

  it('3607 applied: the removal fields are read', async () => {
    const r = await loadSubmissionChecklists(client({ has3596: true, has3607: true }, []), 'sub-1');
    expect(r.ok && r.sections[0].removedAtReviewBy).toBe('b');
  });

  it('any other error still fails the whole section', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await loadSubmissionChecklists(client({ has3596: true, has3607: true, otherError: true }, []), 'sub-1');
    quiet.mockRestore();
    expect(r.ok).toBe(false);
  });
});
