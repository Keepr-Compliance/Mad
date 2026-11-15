// @vitest-environment jsdom

/**
 * BACKLOG-4219 PR3 (SR F1): useReportAccess(reportKey, userId) asks report_my_access again when
 * its key changes, and the returned value follows the new key. The stubbed browser client answers
 * per p_key with DIFFERENT levels, so a hook that kept the first key's answer would be seen.
 */

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as string[],
  answers: { 'sender-rules': 'owner', 'learn-pilot': 'viewer' } as Record<string, string>,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: async (fn: string, args: { p_key: string }) => {
      if (fn === 'report_my_access') state.calls.push(args.p_key);
      return { data: state.answers[args.p_key] ?? null, error: null };
    },
  }),
}));

import { useReportAccess } from '@/lib/reports/use-report-access';

afterEach(() => {
  cleanup();
  state.calls.length = 0;
});

describe('useReportAccess re-reads when the report key changes', () => {
  it('asks for key B after key A, and returns B\'s answer', async () => {
    const { result, rerender } = renderHook(({ k }) => useReportAccess(k, 'user-test'), {
      initialProps: { k: 'sender-rules' },
    });
    await waitFor(() => expect(result.current).toBe('owner'));
    expect(state.calls).toEqual(['sender-rules']);

    rerender({ k: 'learn-pilot' });
    await waitFor(() => expect(result.current).toBe('viewer'));
    expect(state.calls).toEqual(['sender-rules', 'learn-pilot']);
  });
});
