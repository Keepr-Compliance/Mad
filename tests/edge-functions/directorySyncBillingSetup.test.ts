/**
 * @jest-environment node
 *
 * BACKLOG-4012 (D1/D2): directory sync adds and re-activates no one while the brokerage's
 * billing setup is pending, and counts only memberships actually written.
 *
 * Note: today every directory-sync membership insert fails the provisioned_by CHECK on the
 * database (it does not list 'directory_sync'), so this path is not reachable in production
 * until that CHECK is widened. The fake below returns that CHECK error where the real database
 * does (D2b), and the member trigger's P0001 billing_setup_incomplete (D2a). Both error shapes
 * are from keepr-test: C3 (P0001) and the CHECK name read from pg_constraint.
 *
 * index.ts is Deno source that calls Deno.serve at load: the Deno global is stubbed and the
 * jsr: modules are virtual. Provider users are injected (no network).
 */

jest.mock('jsr:@supabase/functions-js/edge-runtime.d.ts', () => ({}), { virtual: true });
jest.mock('jsr:@supabase/supabase-js@2', () => ({ createClient: jest.fn() }), { virtual: true });

(globalThis as unknown as { Deno: unknown }).Deno = { serve: jest.fn(), env: { get: () => undefined } };

import { billingSkipMessage, readJoinsBlocked } from '../../supabase/functions/_shared/billingSetup';

type Row = Record<string, unknown>;
type Err = { code?: string; message: string } | null;
type Write = { table: string; op: 'insert' | 'update' | 'delete'; payload?: Row; filters: Row };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sync = require('../../supabase/functions/directory-sync/index') as {
  syncOrganization: (db: unknown, orgId: string, org: Row, idp: Row, opts?: Row) => Promise<Row>;
};

const ORG = 'org-dir';
const BILLING_REFUSAL = { code: 'P0001', message: 'billing_setup_incomplete', details: null, hint: 'x' };
const CHECK_REFUSAL = {
  code: '23514',
  message: 'new row for relation "organization_members" violates check constraint "organization_members_provisioned_by_check"',
};

function makeDb(tables: Record<string, Row[]>, memberInsertError: Err = null) {
  const writes: Write[] = [];
  let seq = 0;
  function from(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row | undefined;
    const filters: Row = {};
    const preds: Array<(r: Row) => boolean> = [];
    const run = (): { data: unknown; error: Err } => {
      const rows = (tables[table] ??= []);
      const hit = rows.filter((r) => preds.every((p) => p(r)));
      if (op === 'select') return { data: hit.map((r) => ({ ...r })), error: null };
      if (op === 'insert') {
        if (table === 'organization_members' && memberInsertError) {
          writes.push({ table, op, payload, filters });
          return { data: null, error: memberInsertError };
        }
        const row = { id: `${table}-new-${++seq}`, ...payload };
        rows.push(row);
        writes.push({ table, op, payload, filters });
        return { data: row, error: null };
      }
      if (op === 'update') {
        for (const r of hit) Object.assign(r, payload);
        writes.push({ table, op, payload, filters });
        return { data: null, error: null };
      }
      tables[table] = rows.filter((r) => !hit.includes(r));
      writes.push({ table, op, filters });
      return { data: null, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b,
      insert: (p: Row) => { op = 'insert'; payload = p; return b; },
      update: (p: Row) => { op = 'update'; payload = p; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (k: string, v: unknown) => { filters[k] = v; preds.push((r) => r[k] === v); return b; },
      in: (k: string, v: unknown[]) => { preds.push((r) => v.includes(r[k])); return b; },
      single: async () => { const r = run(); return { data: r.data, error: r.error }; },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  // user_id_for_auth_email: the auth-backed account with that sign-in email, else null.
  const rpc = async (fn: string, args: Row) =>
    fn === 'user_id_for_auth_email'
      ? { data: (tables.auth_users ?? []).find((u) => u.email === args.p_email)?.id ?? null, error: null }
      : { data: null, error: null };
  return { client: { from, rpc }, writes, tables };
}

const IDP = { id: 'idp-1', organization_id: ORG, provider_type: 'azure_ad', client_id: null, client_secret_encrypted: null,
  service_account_key_encrypted: null, issuer_url: null, is_active: true, attribute_mapping: null };
const ORG_ROW = { id: ORG, default_member_role: 'agent' };
const person = (externalId: string, email: string) => ({ externalId, email, firstName: null, lastName: null, displayName: null, groups: [] });

/** One departed member, one suspended member who is back, one new person, one existing Keepr person. */
function fixture() {
  return {
    organization_members: [
      { organization_id: ORG, user_id: 'u-dep', provisioned_by: 'directory_sync', license_status: 'active', group_sync_enabled: null, role: 'agent' },
      { organization_id: ORG, user_id: 'u-back', provisioned_by: 'directory_sync', license_status: 'suspended', group_sync_enabled: null, role: 'agent' },
    ],
    users: [
      { id: 'u-dep', email: 'dep@example.test', oauth_id: 'ext-dep', scim_external_id: null, suspended_at: null },
      { id: 'u-back', email: 'back@example.test', oauth_id: 'ext-back', scim_external_id: null, suspended_at: '2026-10-01T00:00:00Z' },
      { id: 'u-ex', email: 'ex@example.test', oauth_id: null, scim_external_id: null },
    ],
    auth_users: [{ id: 'u-ex', email: 'ex@example.test' }],
    organizations: [{ id: ORG, directory_sync_error: null }],
  } as Record<string, Row[]>;
}
const PROVIDER = [person('ext-back', 'back@example.test'), person('ext-new', 'new@example.test'), person('ext-ex', 'ex@example.test')];
const fetchUsers = async () => PROVIDER.map((p) => ({ ...p }));

const memberInserts = (w: Write[]) => w.filter((x) => x.table === 'organization_members' && x.op === 'insert');
const userInserts = (w: Write[]) => w.filter((x) => x.table === 'users' && x.op === 'insert');
const member = (t: Record<string, Row[]>, id: string) => t.organization_members.find((m) => m.user_id === id);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('D1 billing setup pending: nobody added or re-activated', () => {
  it('no member or users inserts, re-activation untouched, departed member still suspended, skips counted', async () => {
    const t = fixture();
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { joinsBlocked: true, fetchUsers });
    expect(memberInserts(db.writes)).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(db.writes.filter((w) => w.table === 'users' && w.op === 'update' && w.filters.id === 'u-ex')).toHaveLength(0);
    expect(member(t, 'u-back')?.license_status).toBe('suspended');
    expect(t.users.find((u) => u.id === 'u-back')?.suspended_at).toBe('2026-10-01T00:00:00Z');
    expect(member(t, 'u-dep')?.license_status).toBe('suspended');
    expect(r).toMatchObject({ added: 0, reactivated: 0, suspended: 1, skipped_billing_setup: 3, error: null });
    expect(t.organizations[0].directory_sync_error).toBe('Billing setup not finished: 3 people not added yet.');
  });

  it('control: the same fixture with joins open adds both people and re-activates the returning member', async () => {
    const t = fixture();
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { joinsBlocked: false, fetchUsers });
    expect(memberInserts(db.writes)).toHaveLength(2);
    expect(member(t, 'u-back')?.license_status).toBe('active');
    expect(r).toMatchObject({ added: 2, reactivated: 1, suspended: 1, skipped_billing_setup: 0 });
    expect(t.organizations[0].directory_sync_error).toBeNull();
  });
});

describe('D2 every membership insert reads its error', () => {
  it('D2a the trigger refuses (setup started after the check): skipped, not added; the fresh users row removed', async () => {
    const t = fixture();
    const db = makeDb(t, BILLING_REFUSAL);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { joinsBlocked: false, fetchUsers });
    expect(r).toMatchObject({ added: 0, skipped_billing_setup: 2 });
    expect(t.users.some((u) => u.email === 'new@example.test')).toBe(false);
    expect(t.organizations[0].directory_sync_error).toBe('Billing setup not finished: 2 people not added yet.');
  });

  it('D2b any other refusal (the provisioned_by CHECK) is not counted as added', async () => {
    const t = fixture();
    const db = makeDb(t, CHECK_REFUSAL);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { joinsBlocked: false, fetchUsers });
    expect(r).toMatchObject({ added: 0, skipped_billing_setup: 0 });
  });
});

describe('readJoinsBlocked', () => {
  it('asks _billing_org_join_blocked for the org', async () => {
    const calls: unknown[] = [];
    const client = { rpc: async (fn: string, args: Row) => { calls.push([fn, args]); return { data: true, error: null }; } };
    await expect(readJoinsBlocked(client, ORG)).resolves.toBe(true);
    expect(calls).toEqual([['_billing_org_join_blocked', { p_org: ORG }]]);
  });

  it('a read error or a throw is not blocked (the trigger still enforces)', async () => {
    await expect(readJoinsBlocked({ rpc: async () => ({ data: null, error: { message: 'boom' } }) }, ORG)).resolves.toBe(false);
    await expect(readJoinsBlocked({ rpc: async () => { throw new Error('down'); } }, ORG)).resolves.toBe(false);
  });

  it('message wording', () => {
    expect(billingSkipMessage(1)).toBe('Billing setup not finished: 1 person not added yet.');
  });
});
