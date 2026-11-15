// @vitest-environment jsdom

/**
 * BACKLOG-4186 PR C (coordinator ruling 2026-11-10): on the sender-rules page an editor has no extra
 * power, so the share dialog describes "Can edit" as the same as "Can view". Other reports keep the
 * report copy (the prop defaults to it). The level labels themselves live in the shared @keepr/ui
 * SharingDialog and are not changed here. BACKLOG-3513 PR-4: the lines reach the dialog as
 * `levels[].description`, so both the Access select and a row's access menu show them.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: async () => ({ data: [], error: null }) }) }));

import { ReportShareButton } from '@/components/reports/ReportShareButton';
import { createReportAccessApi } from '@/lib/reports/report-access-api';
import { withReportAccess } from '@/lib/reports/__tests__/report-access-wrapper';
import { SENDER_RULES_SHARE_ROLE_DESCRIPTIONS } from '@/lib/sender-rules/access';

const api = createReportAccessApi(() => ({ rpc: async () => ({ data: [], error: null }) }) as unknown as SupabaseClient);

async function accessOptions(title: string): Promise<string[]> {
  fireEvent.click(screen.getByRole('button', { name: `Share ${title}` }));
  const dialog = await screen.findByRole('dialog', { name: `Share “${title}”` });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Access Can/ })).toBeTruthy());
  fireEvent.click(within(dialog).getByRole('button', { name: /^Access Can/ }));
  return screen.getAllByRole('option').map((o) => o.textContent ?? '');
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('share dialog role lines', () => {
  it('sender rules: editor described as the same as viewer', async () => {
    render(<ReportShareButton api={api} roleDescriptions={SENDER_RULES_SHARE_ROLE_DESCRIPTIONS} />, {
      wrapper: withReportAccess('owner', 'sender-rules', 'Sender rules'),
    });
    const opts = await accessOptions('Sender rules');
    expect(opts.find((o) => o.startsWith('Can edit'))).toContain('Same as Can view on this page: sees the rules');
    expect(opts.join(' ')).not.toContain('Also shares saved views on it');
  });

  it('another report (no prop): the report copy is unchanged', async () => {
    render(<ReportShareButton api={api} />, { wrapper: withReportAccess('owner', 'funnel', 'Paywall Funnel') });
    const opts = await accessOptions('Paywall Funnel');
    expect(opts.find((o) => o.startsWith('Can edit'))).toContain('Also shares saved views on it');
  });
});
