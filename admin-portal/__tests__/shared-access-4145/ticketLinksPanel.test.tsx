// @vitest-environment jsdom

/**
 * BACKLOG-4145 PR 2: the PM item's Support Tickets panel.
 *
 * - Without support.view, rows come from pm_list_backlog_ticket_links and carry only its three
 *   fields; no direct table read; no Link Ticket / Unlink controls.
 * - With support.view, the link rows are read (link id, type, ticket id) and the controls show.
 * - Ticket search goes through support_search_tickets_for_link; no support_tickets read.
 *
 * RPC fixture transcribed from supabase/migrations/20261108150000_backlog_4145_shared_table_access_helpers.sql:67
 *   RETURNS TABLE (ticket_number integer, subject text, status text)
 * and :84  SELECT t.ticket_number, t.subject, t.status
 * Search fixture from 20261001044523_backlog_3646_support_agent_checks.sql:194
 *   RETURNS TABLE(id uuid, ticket_number integer, subject text, status text, requester_name text)
 * Invented values.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const state = { perms: new Set<string>() };

const PM_RPC_ROWS = [{ ticket_number: 41, subject: 'Invented export question', status: 'open' }];
const LINK_ROWS = [{
  id: 'link-a1',
  link_type: 'fix',
  ticket_id: 'ticket-b1',
  support_tickets: { ticket_number: 41, subject: 'Invented export question', status: 'open' },
}];
const SEARCH_ROWS = [
  { id: 'ticket-b1', ticket_number: 41, subject: 'Invented export question', status: 'open', requester_name: 'requester-x' },
  { id: 'ticket-b2', ticket_number: 42, subject: 'Invented sync question', status: 'new', requester_name: 'requester-x' },
];

function tableChain(table: string) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'is', 'not', 'limit', 'ilike']) c[m] = () => c;
  c.then = (res: (v: unknown) => unknown) => {
    calls.push(`from:${table}`);
    return Promise.resolve({ data: table === 'support_ticket_backlog_links' ? LINK_ROWS : [], error: null }).then(res);
  };
  return c;
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (t: string) => tableChain(t),
    rpc: async (fn: string) => {
      calls.push(`rpc:${fn}`);
      if (fn === 'pm_list_backlog_ticket_links') return { data: PM_RPC_ROWS, error: null };
      if (fn === 'support_search_tickets_for_link') return { data: SEARCH_ROWS, error: null };
      return { data: null, error: null };
    },
  }),
}));

vi.mock('@/components/providers/PermissionsProvider', () => ({
  usePermissions: () => ({ loading: false, hasPermission: (k: string) => state.perms.has(k) }),
}));

import { SupportTicketLinksPanel } from '@/app/dashboard/pm/components/SupportTicketLinksPanel';
import { getTicketLinksForBacklogItem, searchTicketsForBacklogLink } from '@/lib/support-queries';

beforeEach(() => { calls.length = 0; state.perms = new Set(); });
afterEach(() => cleanup());

describe('getTicketLinksForBacklogItem (BACKLOG-4145)', () => {
  it('reads through pm_list_backlog_ticket_links and returns exactly its three fields', async () => {
    const rows = await getTicketLinksForBacklogItem('item-c1');
    expect(calls).toEqual(['rpc:pm_list_backlog_ticket_links']);
    expect(rows).toEqual(PM_RPC_ROWS);
    expect(Object.keys(rows[0]).sort()).toEqual(['status', 'subject', 'ticket_number']);
  });
});

describe('searchTicketsForBacklogLink (BACKLOG-4145)', () => {
  it('uses support_search_tickets_for_link, never a support_tickets read, and leaves out linked tickets', async () => {
    const rows = await searchTicketsForBacklogLink('Invented', [41]);
    expect(calls).toEqual(['rpc:support_search_tickets_for_link']);
    expect(rows.map((r) => r.ticket_number)).toEqual([42]);
    expect(Object.keys(rows[0]).sort()).toEqual(['id', 'status', 'subject', 'ticket_number']);
  });
});

describe('SupportTicketLinksPanel (BACKLOG-4145)', () => {
  it('without support.view: RPC rows only, no link or unlink controls', async () => {
    render(<SupportTicketLinksPanel itemId="item-c1" />);
    await waitFor(() => expect(screen.getByText('TKT-0041')).toBeTruthy());
    expect(screen.getByText('Invented export question')).toBeTruthy();
    expect(calls).toContain('rpc:pm_list_backlog_ticket_links');
    expect(calls.filter((c) => c.startsWith('from:'))).toEqual([]);
    expect(screen.queryByText('Link Ticket')).toBeNull();
    expect(screen.queryByTitle('Unlink ticket')).toBeNull();
    expect(screen.queryByText('fix')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
  });

  it('with support.view: link rows, link type, Link Ticket and Unlink controls', async () => {
    state.perms.add('support.view');
    render(<SupportTicketLinksPanel itemId="item-c1" />);
    await waitFor(() => expect(screen.getByText('TKT-0041')).toBeTruthy());
    expect(calls).toContain('from:support_ticket_backlog_links');
    expect(calls).not.toContain('rpc:pm_list_backlog_ticket_links');
    expect(screen.getByText('Link Ticket')).toBeTruthy();
    expect(screen.getByTitle('Unlink ticket')).toBeTruthy();
    expect(screen.getByText('fix')).toBeTruthy();
  });
});
