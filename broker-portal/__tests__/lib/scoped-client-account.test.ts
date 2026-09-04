/**
 * The account page's three tables, through the REAL scoped client.
 * BACKLOG-3079.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS: a mocked getDataClient cannot see this failure.
 * ---------------------------------------------------------------------------
 * During impersonation `getDataClient()` returns `createScopedClient(...)`,
 * whose `from()` consults ALLOWED_TABLES. A table missing from that set does
 * NOT read as empty — `createBlockedQueryBuilder` returns a proxy that THROWS
 * on every method, so the read rejects and /dashboard/account 500s for the
 * support session it exists to serve.
 *
 * `users`, `user_preferences` and `organizations` were all missing when this
 * page was written. Every access test passed anyway, because they stub
 * getDataClient and never construct the real thing. /dashboard/users never hit
 * it either: it reaches user rows through an embedded `user:users!…` selector
 * on organization_members, which PostgREST resolves inside that query and never
 * routes through `.from('users')`.
 *
 * So these tests drive the real createScopedClient and assert both halves —
 * the table is reachable, AND the filter it is given is the target user's.
 */

import { createScopedClient } from '@/lib/scoped-client';
import type { SupabaseClient } from '@supabase/supabase-js';

/** pii-allow-uuid: invented, not from any live row. */
const TARGET_USER_ID = '00000000-3079-4000-8000-000000000001';
/** pii-allow-uuid: invented, not from any live row. */
const TARGET_ORG_ID = '00000000-3079-4000-8000-000000000009';

interface Filter {
  op: 'eq' | 'in';
  column: string;
  value: unknown;
}

/** Records the filters the scoped client injects on top of select(). */
function recordingServiceClient() {
  const filters: Record<string, Filter[]> = {};
  const from = jest.fn((table: string) => {
    filters[table] = filters[table] ?? [];
    const q: Record<string, unknown> = {};
    const chain = () => q;
    q.select = jest.fn(chain);
    q.eq = jest.fn((column: string, value: unknown) => {
      filters[table].push({ op: 'eq', column, value });
      return q;
    });
    q.in = jest.fn((column: string, value: unknown) => {
      filters[table].push({ op: 'in', column, value });
      return q;
    });
    q.maybeSingle = jest.fn(async () => ({ data: null, error: null }));
    return q;
  });
  return { client: { from, auth: {} } as unknown as SupabaseClient, filters, from };
}

function scoped() {
  const rec = recordingServiceClient();
  return {
    ...rec,
    client: createScopedClient(rec.client, TARGET_USER_ID, TARGET_ORG_ID),
  };
}

/** Every table /dashboard/account reads, enumerated rather than sampled. */
const ACCOUNT_TABLES = ['users', 'user_preferences', 'organization_members', 'organizations'];

describe('the account page tables are reachable during impersonation', () => {
  it.each(ACCOUNT_TABLES)('%s does not throw', (table) => {
    const s = scoped();
    expect(() => s.client.from(table).select('*')).not.toThrow();
  });

  it('a table that is NOT allowed still throws — the guard is real', () => {
    // Without this, "does not throw" above would pass against a scoped client
    // that had stopped blocking anything at all.
    const s = scoped();
    expect(() => s.client.from('scim_tokens').select('*')).toThrow(
      /not allowed during impersonation/
    );
  });
});

describe('the filters injected are the target user\'s', () => {
  it('users is filtered to the target id', () => {
    const s = scoped();
    s.client.from('users').select('id, email');
    expect(s.filters.users).toEqual([
      { op: 'in', column: 'id', value: [TARGET_USER_ID] },
    ]);
  });

  it('user_preferences is filtered to the target user_id, not an organization', () => {
    // user_preferences has NO organization_id column, so an org filter would
    // error rather than narrow. This is why it is user-scoped.
    const s = scoped();
    s.client.from('user_preferences').select('preferences');
    expect(s.filters.user_preferences).toEqual([
      { op: 'eq', column: 'user_id', value: TARGET_USER_ID },
    ]);
    expect(s.filters.user_preferences.map((f) => f.column)).not.toContain('organization_id');
  });

  it('organizations is filtered to the target org by its own id', () => {
    const s = scoped();
    s.client.from('organizations').select('name, retention_years');
    expect(s.filters.organizations).toEqual([
      { op: 'eq', column: 'id', value: TARGET_ORG_ID },
    ]);
  });

  it('organization_members is filtered to the target user_id', () => {
    const s = scoped();
    s.client.from('organization_members').select('role');
    expect(s.filters.organization_members).toEqual([
      { op: 'eq', column: 'user_id', value: TARGET_USER_ID },
    ]);
  });

  it.each(ACCOUNT_TABLES)('%s receives at least one auto-injected filter', (table) => {
    // An allowed table with NO scoping rule is the dangerous case: reachable,
    // and unfiltered against a service-role client that bypasses RLS.
    const s = scoped();
    s.client.from(table).select('*');
    expect(s.filters[table].length).toBeGreaterThan(0);
  });

  it('never filters by anyone but the target', () => {
    const s = scoped();
    for (const table of ACCOUNT_TABLES) s.client.from(table).select('*');
    const values = Object.values(s.filters)
      .flat()
      .flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value]));
    expect(new Set(values)).toEqual(new Set([TARGET_USER_ID, TARGET_ORG_ID]));
  });
});

describe('writes stay blocked on the new tables', () => {
  it.each(['insert', 'update', 'delete', 'upsert'] as const)(
    '%s on user_preferences throws',
    (method) => {
      const s = scoped();
      const q = s.client.from('user_preferences') as unknown as Record<string, () => unknown>;
      expect(() => q[method]()).toThrow(/blocked during impersonation/);
    }
  );

  it.each(['users', 'organizations'] as const)('update on %s throws', (table) => {
    const s = scoped();
    const q = s.client.from(table) as unknown as Record<string, () => unknown>;
    expect(() => q.update()).toThrow(/blocked during impersonation/);
  });
});
