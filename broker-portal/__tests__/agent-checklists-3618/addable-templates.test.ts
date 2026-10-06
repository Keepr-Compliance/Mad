/**
 * "Add checklist" at review lists brokerage templates only — BACKLOG-3618.
 *
 * loadAddableTemplates (lib/submissions/checklists.ts) runs against the
 * BACKLOG-3364 PostgREST emulator, which applies `eq` / `is` as real filters
 * and records `.order()` calls. RLS already hides other members' own
 * templates from a broker; the explicit owner filter keeps the broker's OWN
 * templates (which the add RPC would refuse) out of the list too.
 *
 * @jest-environment node
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAddableTemplates } from '@/lib/submissions/checklists';
import { FIXTURE_BROKERAGE_ORG_ID, FIXTURE_USER_ID, createPostgrestEmulator, type Row } from '../helpers/postgrestEmulator';

const tpl = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  organization_id: FIXTURE_BROKERAGE_ORG_ID,
  name: `Template ${id}`,
  sort_order: 10,
  archived_at: null,
  owner_user_id: null,
  ...over,
});

function load(rows: Row[]) {
  const emu = createPostgrestEmulator({ rows: { checklist_templates: rows } });
  const client = { from: (t: string) => emu.from(t) } as unknown as SupabaseClient;
  return { emu, result: loadAddableTemplates(client, FIXTURE_BROKERAGE_ORG_ID) };
}

describe('loadAddableTemplates — BACKLOG-3618', () => {
  it('returns active brokerage templates and never an own template', async () => {
    const { result } = load([
      tpl('brokerage'),
      tpl('own', { owner_user_id: FIXTURE_USER_ID }),
      tpl('archived', { archived_at: '2026-09-01T00:00:00+00:00' }),
    ]);
    expect((await result).map((t) => t.id)).toEqual(['brokerage']);
  });

  it('orders by sort_order, then name, then id (ties sort the same way every time)', async () => {
    const { emu, result } = load([tpl('brokerage')]);
    await result;
    expect(emu.state.orders.filter((o) => o.table === 'checklist_templates').map((o) => o.column)).toEqual([
      'sort_order',
      'name',
      'id',
    ]);
  });
});
