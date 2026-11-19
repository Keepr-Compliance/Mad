/**
 * BACKLOG-4263 PR-11a — the broker portal as it is (loader column list at lib/submissions/checklists.ts:142-145, :160,
 * unchanged since 6ffea3c39) reads rows written by snapshot_submission_checklists after migration 20261119100000.
 *
 * ITEM_ROWS: the four submission_checklist_items rows the new function wrote on the test database
 * (supabase/tests/backlog-4263-pr11/harness-11a.sql, record g1b_rows_as_loaded, run of 2026-11-19), transcribed with
 * the loader's columns; ids dropped there and replaced with fixture ids here. The fourth row's payload item carried
 * attribution_v 1 and note_by {kind: 'ai_app', app: 'anthropic'}, which the function stored as attribution_v = 1,
 * note_by_kind = 'ai_app', note_by_app = 'anthropic' (record c_s2, item sw-k). Headers and the link row are the
 * payload's (template_name, sort_order; one attachment link with one member).
 *
 * @jest-environment node
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadSubmissionChecklists } from '@/lib/submissions/checklists';

const NEW_COLUMNS = ['attribution_v', 'note_by_kind', 'note_by_app'];

const HEADERS = [
  { id: 'hdr-1', template_id: null, template_name: 'Purchase', sort_order: 0, added_at_review_by: null, added_at_review_at: null,
    removed_at_review_by: null, removed_at_review_at: null, restored_from_checklist_id: null },
  { id: 'hdr-2', template_id: null, template_name: 'My items', sort_order: 1, added_at_review_by: null, added_at_review_at: null,
    removed_at_review_by: null, removed_at_review_at: null, restored_from_checklist_id: null },
  { id: 'hdr-3', template_id: null, template_name: 'With authors', sort_order: 2, added_at_review_by: null, added_at_review_at: null,
    removed_at_review_by: null, removed_at_review_at: null, restored_from_checklist_id: null },
];
const REVIEW_NULLS = {
  reviewer_checked: false, reviewer_checked_by: null, reviewer_checked_at: null, cleared_reviewer_id: null, cleared_at: null,
  restored_from_item_id: null,
};
/** Every column of the rows as the new function stored them (the loader's columns plus the three new ones). */
const ITEM_ROWS = [
  { id: 'item-1', submission_checklist_id: 'hdr-1', title: 'Inspection report', description: 'Signed copy', is_required: true, is_checked: true,
    note: 'Received from the inspector', sort_order: 0, ...REVIEW_NULLS, attribution_v: null, note_by_kind: null, note_by_app: null },
  { id: 'item-2', submission_checklist_id: 'hdr-1', title: 'Appraisal', description: null, is_required: false, is_checked: false,
    note: null, sort_order: 1, ...REVIEW_NULLS, attribution_v: null, note_by_kind: null, note_by_app: null },
  { id: 'item-3', submission_checklist_id: 'hdr-2', title: 'Call the lender', description: null, is_required: false, is_checked: false,
    note: '   ', sort_order: 0, ...REVIEW_NULLS, attribution_v: null, note_by_kind: null, note_by_app: null },
  { id: 'item-4', submission_checklist_id: 'hdr-3', title: 'AI note', description: null, is_required: true, is_checked: true,
    note: 'Written by an app', sort_order: 0, ...REVIEW_NULLS, attribution_v: 1, note_by_kind: 'ai_app', note_by_app: 'anthropic' },
];
const LINKS = [{ id: 'link-1', submission_checklist_item_id: 'item-1', kind: 'attachment', label: 'Report', sort_order: 0 }];
const MEMBERS = [{ link_id: 'link-1', kind: 'attachment', submission_attachment_id: 'att-1', submission_message_id: null }];

/** `project`: PostgREST returns exactly the selected columns; otherwise every column of the stored row. */
function client(project: boolean, selects: string[]): SupabaseClient {
  const rows: Record<string, Record<string, unknown>[]> = {
    submission_checklists: HEADERS,
    submission_checklist_items: ITEM_ROWS,
    submission_checklist_links: LINKS,
    submission_checklist_link_members: MEMBERS,
  };
  return {
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: () => {
          const q = {
            order: () => q,
            range: async () => {
              selects.push(`${table}: ${cols}`);
              const names = cols.split(',').map((c) => c.trim());
              const data = (rows[table] ?? []).map((r) => (project ? Object.fromEntries(names.map((n) => [n, r[n]])) : { ...r }));
              return { data, error: null, count: data.length };
            },
          };
          return q;
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('BACKLOG-4263 PR-11a: the portal loader and rows written after 20261119100000', () => {
  it('never selects the new columns', async () => {
    const selects: string[] = [];
    const r = await loadSubmissionChecklists(client(true, selects), 'sub-1');
    expect(r.ok).toBe(true);
    const itemSelects = selects.filter((s) => s.startsWith('submission_checklist_items'));
    expect(itemSelects.length).toBeGreaterThan(0);
    for (const s of selects) for (const c of NEW_COLUMNS) expect(`${s} ${s.includes(c)}`).toBe(`${s} false`);
  });

  it('shows the same sections whether or not a row carries the new columns', async () => {
    const projected = await loadSubmissionChecklists(client(true, []), 'sub-1');
    const full = await loadSubmissionChecklists(client(false, []), 'sub-1');
    expect(projected.ok && full.ok).toBe(true);
    if (!projected.ok || !full.ok) return;
    expect(full.sections).toEqual(projected.sections);
    expect(projected.sections.map((s) => s.items.length)).toEqual([2, 1, 1]);
    const text = JSON.stringify(full.sections);
    for (const v of ['anthropic', 'ai_app', 'attribution', 'note_by', 'noteBy']) expect(`${v} ${text.includes(v)}`).toBe(`${v} false`);
    const ai = projected.sections[2].items[0];
    expect(ai.note).toBe('Written by an app');
    expect(ai.isChecked).toBe(true);
    expect(ai.reviewerChecked).toBe(false);
  });
});
