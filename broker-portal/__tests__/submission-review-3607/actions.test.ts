/**
 * Remove / restore / un-remove server actions — BACKLOG-3607, PR 3.
 *
 * RPC names, arguments and returns: supabase/migrations/20260929120000_backlog_3607_checklist_add_remove.sql
 * (PR #2750 @ da1b43459):
 *   remove_submission_checklist_at_review(p_checklist_id)
 *     -> {status 'removed', checklist_id, linked_documents, linked_emails} (:803-804)
 *     -> {status 'already_removed', checklist_id} (:767)
 *   restore_submission_checklist_at_review(p_submission_id, p_source_checklist_id)
 *     -> {status 'restored', checklist_id, items, ticks_restored} (:951-952)
 *     -> {status 'not_removed'} (:894), {status 'already_present'|'removed_here', checklist_id} (:904, :909)
 *   add_submission_checklist_at_review -> {status 'readded', checklist_id} (:328)
 *   refusals: RAISE EXCEPTION '<text>' USING ERRCODE = '42501' | '22023'.
 *
 * @jest-environment node
 */

const mockRpc = jest.fn();
const mockSubmissionRow: unknown = { id: 'sub-1', organization_id: 'org-1', status: 'under_review' };

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'reviewer-id' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mockSubmissionRow, error: null }) }) }),
    }),
    rpc: (...a: unknown[]) => mockRpc(...a),
  })),
}));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: jest.fn() }));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: async () => null }));
const mockRevalidate = jest.fn();
jest.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidate(...a) }));

import {
  addChecklistAtReview,
  removeChecklistAtReview,
  restoreChecklistAtReview,
  setReviewerCheck,
} from '@/lib/actions/submissionChecklists';
import { REVIEW_MESSAGES } from '@/lib/submissions/reviewMessages';

function rpcAnswers(answers: Record<string, { data: unknown; error: unknown }>) {
  mockRpc.mockImplementation(async (name: string) => answers[name] ?? { data: null, error: null });
}
const REVIEWER = { can_review_submission: { data: true, error: null } };

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

function callsTo(name: string) {
  return mockRpc.mock.calls.filter((c) => c[0] === name);
}

describe('removeChecklistAtReview', () => {
  it.each(['removed', 'already_removed'] as const)('%s -> ok, with the checklist id as p_checklist_id', async (status) => {
    rpcAnswers({
      ...REVIEWER,
      remove_submission_checklist_at_review: {
        data: { status, checklist_id: 'hdr-1', linked_documents: 3, linked_emails: 2 },
        error: null,
      },
    });
    const result = await removeChecklistAtReview('sub-1', 'hdr-1');
    expect(result).toEqual({ ok: true, status, checklistId: 'hdr-1' });
    expect(callsTo('remove_submission_checklist_at_review')).toEqual([
      ['remove_submission_checklist_at_review', { p_checklist_id: 'hdr-1' }],
    ]);
    expect(mockRevalidate).toHaveBeenCalledWith('/dashboard/submissions/sub-1');
  });

  it.each([
    ['42501', 'not_authorized', 'not_authorized'],
    ['42501', 'not_open_for_review', 'not_open_for_review'],
    ['42501', 'superseded', 'superseded'],
    ['22023', 'invalid_argument', 'invalid'],
  ] as const)('%s %s -> %s', async (code, message, reason) => {
    rpcAnswers({ ...REVIEWER, remove_submission_checklist_at_review: { data: null, error: { code, message } } });
    expect(await removeChecklistAtReview('sub-1', 'hdr-1')).toEqual({ ok: false, reason, message: REVIEW_MESSAGES[reason] });
  });

  it('an unknown answer is a failure, not a success', async () => {
    rpcAnswers({ ...REVIEWER, remove_submission_checklist_at_review: { data: { status: 'what' }, error: null } });
    expect((await removeChecklistAtReview('sub-1', 'hdr-1')).ok).toBe(false);
  });

  it('an empty id never reaches the RPC', async () => {
    rpcAnswers(REVIEWER);
    expect(await removeChecklistAtReview('sub-1', '')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(callsTo('remove_submission_checklist_at_review')).toHaveLength(0);
  });
});

describe('restoreChecklistAtReview', () => {
  it('restored -> ok; calls restore with THIS version and the source id, never add', async () => {
    rpcAnswers({
      ...REVIEWER,
      restore_submission_checklist_at_review: {
        data: { status: 'restored', checklist_id: 'hdr-new', items: 5, ticks_restored: 4 },
        error: null,
      },
    });
    expect(await restoreChecklistAtReview('sub-1', 'hdr-v1')).toEqual({ ok: true, checklistId: 'hdr-new', ticksRestored: 4 });
    expect(callsTo('restore_submission_checklist_at_review')).toEqual([
      ['restore_submission_checklist_at_review', { p_submission_id: 'sub-1', p_source_checklist_id: 'hdr-v1' }],
    ]);
    expect(callsTo('add_submission_checklist_at_review')).toHaveLength(0);
  });

  it.each(['not_removed', 'already_present', 'removed_here'] as const)('%s -> its own plain copy', async (status) => {
    rpcAnswers({ ...REVIEWER, restore_submission_checklist_at_review: { data: { status, checklist_id: 'h' }, error: null } });
    expect(await restoreChecklistAtReview('sub-1', 'hdr-v1')).toEqual({ ok: false, reason: status, message: REVIEW_MESSAGES[status] });
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('42501 not_authorized (a forged or foreign source id) -> permission copy', async () => {
    rpcAnswers({ ...REVIEWER, restore_submission_checklist_at_review: { data: null, error: { code: '42501', message: 'not_authorized' } } });
    expect(await restoreChecklistAtReview('sub-1', 'hdr-v1')).toMatchObject({ ok: false, reason: 'not_authorized' });
  });
});

describe('addChecklistAtReview: Undo', () => {
  it("'readded' (a removal undone) is a success", async () => {
    rpcAnswers({ ...REVIEWER, add_submission_checklist_at_review: { data: { status: 'readded', checklist_id: 'hdr-1' }, error: null } });
    expect(await addChecklistAtReview('sub-1', 'tpl-1')).toEqual({ ok: true, status: 'readded', checklistId: 'hdr-1' });
  });
});

describe('setReviewerCheck: tick on a removed checklist', () => {
  it("42501 checklist_removed -> the removed copy, not 'no permission'", async () => {
    rpcAnswers({ ...REVIEWER, set_submission_checklist_reviewer_check: { data: null, error: { code: '42501', message: 'checklist_removed' } } });
    expect(await setReviewerCheck('sub-1', 'item-1', true)).toEqual({
      ok: false,
      reason: 'checklist_removed',
      message: REVIEW_MESSAGES.checklist_removed,
    });
  });
});
