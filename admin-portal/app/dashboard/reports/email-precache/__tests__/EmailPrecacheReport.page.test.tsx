// @vitest-environment jsdom
/**
 * Email Sync Timing page (BACKLOG-4130).
 *
 * Renders the REAL server page with the real query and model; only the
 * Supabase server client is stubbed, and it records the query chain so the
 * per-query cap and the source filter are asserted, not assumed.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EP_RUN_LIMIT } from '@/lib/reports/email-precache';

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  calls: [] as Array<[string, unknown[]]>,
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

function queryBuilder(table: string): unknown {
  const proxy: unknown = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') {
        const result = table === 'sync_outcomes' ? { data: state.rows, error: null } : { data: [], error: null };
        return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      if (prop === 'single' || prop === 'maybeSingle') {
        return async () => ({ data: { role_id: 'role-1' }, error: null });
      }
      return (...args: unknown[]) => {
        if (table === 'sync_outcomes') state.calls.push([String(prop), args]);
        return proxy;
      };
    },
  });
  return proxy;
}

vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'user-1' },
    supabase: { rpc: async () => ({ data: true, error: null }), from: (t: string) => queryBuilder(t) },
  }),
}));

import EmailPrecacheReportPage from '@/app/dashboard/reports/email-precache/page';

/** The shape buildSyncOutcomeRow writes for source 'email-precache'. */
function row(i: number, runKind: string, checked: number) {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    user_id: 'user-a',
    created_at: '2026-11-04T10:00:00.000Z',
    outcome: 'complete',
    elapsed_ms: 45_000,
    run_kind: runKind,
    source_metrics: { providers: ['gmail'], checked, written: checked, dbMs: 10, build: '2.46.0', windowMonths: 6, backfill: false },
  };
}

async function renderPage(params: Record<string, string> = {}) {
  render(await EmailPrecacheReportPage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  state.rows = [];
  state.calls = [];
});
afterEach(() => cleanup());

describe('Email Sync Timing page', () => {
  it('reads source email-precache under its own cap', async () => {
    await renderPage();
    expect(state.calls).toContainEqual(['eq', ['source', 'email-precache']]);
    expect(state.calls).toContainEqual(['limit', [EP_RUN_LIMIT]]);
  });

  it('shows the three columns, including forced re-sync, and N per cell', async () => {
    state.rows = [row(1, 'cache', 5000), row(2, 'force', 5000), row(3, 're-cache', 3)];
    await renderPage();
    expect(screen.getByText('First sync')).toBeTruthy();
    expect(screen.getByText('Incremental sync')).toBeTruthy();
    expect(screen.getByText('Forced re-sync')).toBeTruthy();
    expect(document.querySelectorAll('[data-cell-n="1"]').length).toBe(3);
    expect(document.querySelector('[data-notice="truncated"]')).toBeNull();
  });

  it('says so when the cap was hit', async () => {
    state.rows = Array.from({ length: EP_RUN_LIMIT }, (_, i) => row(i, 'cache', 10));
    await renderPage();
    expect(document.querySelector('[data-notice="truncated"]')).not.toBeNull();
  });
});
