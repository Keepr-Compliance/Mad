/**
 * Exports report label (BACKLOG-4025)
 *
 * The "unique" count is per user and deal, so the page subtitle and the
 * reports-index description both say so. Renders the REAL server page with
 * the Supabase client, the queries and the client shell stubbed.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { REPORTS } from '@/lib/reports/registry';

const LABEL = 'unique exports (each user and deal counted once)';

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

vi.mock('@/lib/supabase/server', () => {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    single: async () => ({ data: { role_id: 'r1' }, error: null }),
  };
  return {
    getAuthenticatedUser: async () => ({
      user: { id: 'u-1' },
      supabase: { from: () => builder, rpc: async () => ({ data: true, error: null }) },
    }),
  };
});

vi.mock('@/lib/reports/exports-queries', () => ({
  EXPORT_LIMIT: 500,
  getExportEvents: async () => ({ rows: [], truncated: false }),
  getExportLookups: async () => ({ users: [], memberships: [], orgs: [], failed: false }),
}));

vi.mock('../ExportsReportClient', () => ({
  ExportsReportClient: () => null,
}));

import ExportsReportPage from '../page';

describe('exports label says each user and deal is counted once', () => {
  it('registry description', () => {
    const entry = REPORTS.find((r) => r.slug === 'exports');
    expect(entry?.description).toContain(LABEL);
    expect(entry?.description).not.toContain('unique deals');
  });

  it('page subtitle', async () => {
    const out = renderToStaticMarkup(await ExportsReportPage({ searchParams: Promise.resolve({}) }));
    expect(out).toContain(`how many were ${LABEL}, in which formats, and when.`);
    expect(out).not.toContain('unique deals');
  });
});
