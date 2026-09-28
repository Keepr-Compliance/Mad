/**
 * Reviewer server actions and markAsUnderReview — BACKLOG-3477.
 *
 * RPC error fixtures: the migration raises
 *   RAISE EXCEPTION 'not_authorized' | 'not_open_for_review' | 'added_at_review'
 *     USING ERRCODE = '42501'
 *   RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023'
 * (20260925073000_backlog_3477_submission_checklist_review.sql §7/§8), which
 * PostgREST returns to supabase-js as { code: '42501', message: '<text>' }.
 * RPC returns: §7 {changed, reviewer_checked, reviewer_checked_by,
 * reviewer_checked_at}; §8 {status: added|exists|template_not_found, ...}.
 *
 * @jest-environment node
 */

const mockRpc = jest.fn();
let mockSubmissionRow: unknown = { id: 'sub-1', organization_id: 'org-1', status: 'under_review' };
let mockUpdateResult: { data: unknown; error: unknown } = { data: [], error: null };
const mockWrites: unknown[] = [];

jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'reviewer-id' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mockSubmissionRow, error: null }) }) }),
      update: (values: unknown) => {
        mockWrites.push(values);
        return { eq: () => ({ select: async () => mockUpdateResult }) };
      },
    }),
    rpc: (...a: unknown[]) => mockRpc(...a),
  })),
}));
jest.mock('@/lib/supabase/service', () => ({ createServiceClient: jest.fn() }));
const mockImpersonation = jest.fn(async (): Promise<unknown> => null);
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: () => mockImpersonation() }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));

import { addChecklistAtReview, setReviewerCheck } from '@/lib/actions/submissionChecklists';
import { markAsUnderReview } from '@/lib/submissions/markUnderReview';
import { REVIEW_MESSAGES } from '@/lib/submissions/reviewMessages';

function rpcAnswers(answers: Record<string, { data: unknown; error: unknown }>) {
  mockRpc.mockImplementation(async (name: string) => answers[name] ?? { data: null, error: null });
}
const REVIEWER = { can_review_submission: { data: true, error: null } };

let quiet: jest.SpyInstance[] = [];
beforeEach(() => {
  jest.clearAllMocks();
  mockWrites.length = 0;
  mockSubmissionRow = { id: 'sub-1', organization_id: 'org-1', status: 'under_review' };
  mockUpdateResult = { data: [], error: null };
  quiet = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {})];
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

describe('setReviewerCheck', () => {
  it.each([
    ['not_authorized', 'not_authorized'],
    ['not_open_for_review', 'not_open_for_review'],
    ['added_at_review', 'added_at_review'],
  ] as const)('maps 42501 %s to plain copy', async (message, reason) => {
    rpcAnswers({ ...REVIEWER, set_submission_checklist_reviewer_check: { data: null, error: { code: '42501', message } } });
    const result = await setReviewerCheck('sub-1', 'item-1', true);
    expect(result).toEqual({ ok: false, reason, message: REVIEW_MESSAGES[reason] });
    if (!result.ok) expect(result.message).not.toMatch(/42501|_/);
  });

  it('maps 22023 to invalid', async () => {
    rpcAnswers({ ...REVIEWER, set_submission_checklist_reviewer_check: { data: null, error: { code: '22023', message: 'invalid_argument' } } });
    expect(await setReviewerCheck('sub-1', 'item-1', true)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('returns the RPC’s reviewer values on success', async () => {
    rpcAnswers({
      ...REVIEWER,
      set_submission_checklist_reviewer_check: {
        data: { changed: true, reviewer_checked: true, reviewer_checked_by: 'reviewer-id', reviewer_checked_at: '2026-09-21T09:00:00+00:00' },
        error: null,
      },
    });
    expect(await setReviewerCheck('sub-1', 'item-1', true)).toEqual({
      ok: true,
      changed: true,
      reviewerChecked: true,
      reviewerCheckedBy: 'reviewer-id',
      reviewerCheckedAt: '2026-09-21T09:00:00+00:00',
    });
  });

  it('refuses a non-reviewer before calling the tick RPC', async () => {
    rpcAnswers({ can_review_submission: { data: false, error: null } });
    expect(await setReviewerCheck('sub-1', 'item-1', true)).toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(mockRpc.mock.calls.map((c) => c[0])).toEqual(['can_review_submission']);
  });

  it('refuses during impersonation before any read', async () => {
    mockImpersonation.mockResolvedValueOnce({ targetUserId: 'x' });
    rpcAnswers(REVIEWER);
    expect(await setReviewerCheck('sub-1', 'item-1', true)).toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('addChecklistAtReview', () => {
  it('maps template_not_found to plain copy', async () => {
    rpcAnswers({ ...REVIEWER, add_submission_checklist_at_review: { data: { status: 'template_not_found' }, error: null } });
    expect(await addChecklistAtReview('sub-1', 'tpl-1')).toEqual({
      ok: false,
      reason: 'template_not_found',
      message: REVIEW_MESSAGES.template_not_found,
    });
  });

  it('treats exists as done', async () => {
    rpcAnswers({ ...REVIEWER, add_submission_checklist_at_review: { data: { status: 'exists', checklist_id: 'hdr-1' }, error: null } });
    expect(await addChecklistAtReview('sub-1', 'tpl-1')).toEqual({ ok: true, status: 'exists', checklistId: 'hdr-1' });
  });

  it('maps not_open_for_review (needs_changes) to plain copy', async () => {
    rpcAnswers({ ...REVIEWER, add_submission_checklist_at_review: { data: null, error: { code: '42501', message: 'not_open_for_review' } } });
    expect(await addChecklistAtReview('sub-1', 'tpl-1')).toMatchObject({
      ok: false,
      message: REVIEW_MESSAGES.not_open_for_review,
    });
  });

  /**
   * C-F (SR addendum 80f5ae11): the add RPC will refuse a version that has a
   * newer version with `RAISE EXCEPTION 'superseded' USING ERRCODE = '42501'`
   * (the tick RPC's exact shape, 20260928120000…sql §5; the add refusal is a
   * separate cloud migration, not applied). supabase-js surfaces it as
   * {code, message}. The broker reads the newer-version words, not the
   * permission words.
   */
  it('maps 42501 superseded to the newer-version words, not the permission words', async () => {
    rpcAnswers({ ...REVIEWER, add_submission_checklist_at_review: { data: null, error: { code: '42501', message: 'superseded' } } });
    const result = await addChecklistAtReview('sub-1', 'tpl-1');
    expect(result).toEqual({ ok: false, reason: 'superseded', message: REVIEW_MESSAGES.superseded });
    if (!result.ok) {
      expect(result.message).toBe(
        'A newer version of this submission has been sent, so this version is closed. Check items on the newest version.'
      );
      expect(result.message).not.toBe(REVIEW_MESSAGES.not_authorized);
    }
  });
});

describe('markAsUnderReview', () => {
  const sub = { id: 'sub-1', status: 'submitted' };

  it('reports a zero-row update as a failure', async () => {
    mockUpdateResult = { data: [], error: null };
    expect(await markAsUnderReview(sub, { isImpersonating: false, canDecide: true })).toBe('no_rows');
    expect(console.error).toHaveBeenCalledWith(
      'Marking submission as under_review matched no rows',
      { submissionId: 'sub-1' }
    );
  });

  it('a one-row update is updated', async () => {
    mockUpdateResult = { data: [{ id: 'sub-1' }], error: null };
    expect(await markAsUnderReview(sub, { isImpersonating: false, canDecide: true })).toBe('updated');
  });

  it('is skipped for a reviewer who may not decide, with no write', async () => {
    expect(await markAsUnderReview(sub, { isImpersonating: false, canDecide: false })).toBe('skipped');
    expect(mockWrites).toEqual([]);
  });
});
