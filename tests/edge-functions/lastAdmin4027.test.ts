/**
 * @jest-environment node
 *
 * BACKLOG-4027 PR-1: a brokerage always keeps one active admin (founder decision B), and SCIM
 * matches an existing Keepr person by userName, then by the emails[] values.
 *
 * The database client is an in-memory fake. It emulates public._guard_last_admin as a sync
 * writer meets it (service_role + scim_synced_at changed): an update that would leave the
 * brokerage with no active admin (role 'admin', licence 'active', an account) keeps role and
 * licence as they were, applies the rest, writes one billing_change_log row
 * ('sync_change_skipped_last_admin'), and raises nothing. The RETURNING row then carries the kept
 * values. Shape transcribed from keepr-test control T1 (supabase/tests/backlog-4027/controls.sql):
 * a sync demotion of the last admin returned {"role": "admin", "license_status": "active"}.
 * fetch is injected: no network.
 */

jest.mock('jsr:@supabase/supabase-js@2', () => ({ createClient: jest.fn() }), { virtual: true });
jest.mock('jsr:@supabase/functions-js/edge-runtime.d.ts', () => ({}), { virtual: true });
(globalThis as unknown as { Deno: unknown }).Deno = { serve: jest.fn(), env: { get: () => undefined } };

import {
  LAST_ADMIN_KEPT,
  LAST_ADMIN_LOG_ACTION,
  notifyLastAdminKept,
  type LastAdminNotifyDeps,
} from '../../supabase/functions/_shared/lastAdminNotify';

type Handler = (...args: unknown[]) => Promise<Response>;
// Deno source (jsr: imports): required, not imported, as in scimSeats.test.ts.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const users = require('../../supabase/functions/scim/handlers/users') as {
  handleCreateUser: Handler;
  handlePatchUser: Handler;
  handleDeleteUser: Handler;
  scimEmailCandidates: (body: Record<string, unknown>) => string[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sync = require('../../supabase/functions/directory-sync/index') as {
  syncOrganization: (db: unknown, orgId: string, org: Row, idp: Row, opts?: Row) => Promise<Row>;
};

type Row = Record<string, unknown>;
type Err = { code?: string; message: string } | null;
type Write = { table: string; op: 'insert' | 'update' | 'delete'; payload?: Row; rows: Row[] };

const ORG = 'org-1';
const NOW = Date.parse('2026-10-21T12:00:00Z');

const LAST_ADMIN_REFUSAL = { code: 'P0001', message: 'last_admin' };
const isActiveAdmin = (r: Row) => r.role === 'admin' && r.license_status === 'active' && !!r.user_id;

function makeDb(tables: Record<string, Row[]>, opts: { authEmails?: Record<string, string> } = {}) {
  const writes: Write[] = [];
  let seq = 0;

  function guardLastAdmin(old: Row, next: Row): Row {
    if (!isActiveAdmin(old) || isActiveAdmin(next)) return next;
    const others = (tables.organization_members ?? []).filter(
      (m) => m !== old && m.organization_id === old.organization_id && isActiveAdmin(m),
    );
    if (others.length > 0) return next;
    if (next.scim_synced_at === old.scim_synced_at) throw LAST_ADMIN_REFUSAL; // not a sync write: the trigger raises
    (tables.billing_change_log ??= []).push({
      id: `bcl-${++seq}`,
      organization_id: old.organization_id,
      action: 'sync_change_skipped_last_admin',
      created_at: new Date(NOW).toISOString(),
    });
    return { ...next, role: old.role, license_status: old.license_status };
  }

  function from(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let cols = '*';
    let payload: Row | undefined;
    let returning: string | null = null;
    let head = false;
    const filters: Array<(r: Row) => boolean> = [];
    const project = (r: Row, c: string): Row => {
      if (c.trim() === '*') return { ...r };
      const out: Row = {};
      for (const k of c.split(',').map((x) => x.trim())) out[k] = r[k];
      return out;
    };
    const run = (): { data: unknown; error: Err; count?: number } => {
      const rows = (tables[table] ??= []);
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'select') {
        if (head) return { data: null, error: null, count: hit.length };
        return { data: hit.map((r) => project(r, cols)), error: null };
      }
      if (op === 'insert') {
        const row: Row = { id: `${table}-new-${++seq}`, ...payload };
        if (table === 'scim_sync_log') row.created_at = new Date(NOW).toISOString();
        rows.push(row);
        writes.push({ table, op, payload, rows: [row] });
        return { data: returning ? [project(row, returning)] : row, error: null };
      }
      if (op === 'update') {
        let kept: Row[];
        try {
          kept = hit.map((r) => (table === 'organization_members' ? guardLastAdmin(r, { ...r, ...payload }) : { ...r, ...payload }));
        } catch (e) {
          writes.push({ table, op, payload, rows: [] });
          return { data: null, error: e as Err };
        }
        hit.forEach((r, i) => Object.assign(r, kept[i]));
        writes.push({ table, op, payload, rows: hit.map((r) => ({ ...r })) });
        return { data: returning ? hit.map((r) => project(r, returning as string)) : null, error: null };
      }
      tables[table] = rows.filter((r) => !hit.includes(r));
      writes.push({ table, op, rows: hit });
      return { data: null, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: (c = '*', o?: { count?: string; head?: boolean }) => {
        if (op === 'select') cols = c;
        else returning = c;
        head = !!o?.head;
        return b;
      },
      insert: (p: Row) => { op = 'insert'; payload = p; return b; },
      update: (p: Row) => { op = 'update'; payload = p; return b; },
      delete: () => { op = 'delete'; return b; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      neq: (k: string, v: unknown) => { filters.push((r) => r[k] !== v); return b; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return b; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return b; },
      gte: (k: string, v: string) => { filters.push((r) => String(r[k] ?? '') >= v); return b; },
      not: () => b,
      order: () => b,
      range: () => b,
      maybeSingle: async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
      },
      single: async () => {
        const r = run();
        const d = Array.isArray(r.data) ? r.data[0] : r.data;
        return { data: d ?? null, error: r.error ?? (d ? null : { message: 'no rows' }) };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  // user_id_for_auth_email: the account whose sign-in email matches (opts.authEmails: id -> email).
  const rpcCalls: string[] = [];
  async function rpc(fn: string, args: Row) {
    if (fn !== 'user_id_for_auth_email') return { data: null, error: null };
    const e = String(args.p_email ?? '').trim().toLowerCase();
    rpcCalls.push(e);
    const hit = Object.entries(opts.authEmails ?? {}).filter(([, v]) => v === e).map(([k]) => k);
    return { data: hit.length === 1 ? hit[0] : null, error: null };
  }
  return { client: { from, rpc }, writes, tables, rpcCalls };
}

function deps() {
  const fetch = jest.fn(async (_url: string, _init?: RequestInit) => new Response('{"success":true}', { status: 200 }));
  const d: LastAdminNotifyDeps = {
    fetch,
    getEnv: (k: string) => ({ BROKER_PORTAL_URL: 'https://portal.test', INTERNAL_API_SECRET: 'internal-secret' } as Record<string, string>)[k],
    now: () => NOW,
    timeoutMs: 50,
  };
  return { d, fetch };
}

const AUTH = { orgId: ORG, tokenId: 'tok-1', permissions: { canCreate: true, canUpdate: true, canDelete: true } };
const BASE = 'https://proj.supabase.test/functions/v1/scim';

/** One brokerage: the only admin (u-ad), an IT admin who is the IT contact (u-it), an agent. */
function tables(extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    organizations: [{ id: ORG, name: 'Example Brokerage 4027', max_seats: 10, default_member_role: 'agent', personal_owner_user_id: null }],
    users: [
      { id: 'u-ad', email: 'admin@example.test', first_name: 'Ada', last_name: 'Admin', suspended_at: null },
      { id: 'u-it', email: 'it@example.test', suspended_at: null },
      { id: 'u-ag', email: 'agent@example.test', suspended_at: null },
    ],
    organization_members: [
      { id: 'm-ad', organization_id: ORG, user_id: 'u-ad', role: 'admin', license_status: 'active', scim_synced_at: null },
      { id: 'm-it', organization_id: ORG, user_id: 'u-it', role: 'it_admin', license_status: 'active', scim_synced_at: null },
      { id: 'm-ag', organization_id: ORG, user_id: 'u-ag', role: 'agent', license_status: 'active', scim_synced_at: null },
    ],
    org_contacts: [{ id: 'c-it', organization_id: ORG, role: 'it', member_id: 'm-it', removed_at: null }],
    billing_change_log: [],
    scim_sync_log: [],
    organization_identity_providers: [],
    ...extra,
  };
}

const patchReq = (id: string, ops: unknown[]) =>
  new Request(`${BASE}/scim/v2/Users/${id}`, { method: 'PATCH', body: JSON.stringify({ schemas: [], Operations: ops }) });
const member = (t: Record<string, Row[]>, uid: string) => t.organization_members.find((m) => m.user_id === uid);
const userWrites = (w: Write[]) => w.filter((x) => x.table === 'users');

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// SCIM: the last active admin
// ---------------------------------------------------------------------------

describe('SCIM DELETE / PATCH active:false on the last admin', () => {
  it('DELETE: 403 last_admin_kept, member still active, users row untouched, logged, one email to support + IT contact', async () => {
    const t = tables();
    const db = makeDb(t);
    const { d, fetch } = deps();
    const res = await users.handleDeleteUser('u-ad', AUTH as never, db.client as never, d);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe('403');
    expect(String(body.detail).startsWith('last_admin_kept')).toBe(true);
    expect(member(t, 'u-ad')?.license_status).toBe('active');
    expect(userWrites(db.writes)).toHaveLength(0);
    expect(t.scim_sync_log.map((l) => [l.operation, l.response_status, l.error_message])).toEqual([['DELETE', 403, LAST_ADMIN_KEPT]]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://portal.test/api/email/last-admin-kept');
    const sent = JSON.parse(String(init.body));
    expect(sent.recipients.sort()).toEqual(['it@example.test', 'support@keeprcompliance.com']);
    expect(sent).toMatchObject({ personLabel: 'Ada Admin', brokerageName: 'Example Brokerage 4027', kind: 'deactivate', source: 'scim' });
  });

  it('PATCH active:false: 403, member still active, users row untouched', async () => {
    const t = tables();
    const db = makeDb(t);
    const { d, fetch } = deps();
    const res = await users.handlePatchUser(patchReq('u-ad', [{ op: 'replace', path: 'active', value: false }]), 'u-ad', AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(403);
    expect(member(t, 'u-ad')?.license_status).toBe('active');
    expect(userWrites(db.writes)).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('control: DELETE of an admin who is not the last goes through: 204, suspended, users row suspended, no email', async () => {
    const t = tables();
    t.organization_members.push({ id: 'm-ad2', organization_id: ORG, user_id: 'u-ad2', role: 'admin', license_status: 'active', scim_synced_at: null });
    t.users.push({ id: 'u-ad2', email: 'admin2@example.test', suspended_at: null });
    const db = makeDb(t);
    const { d, fetch } = deps();
    const res = await users.handleDeleteUser('u-ad', AUTH as never, db.client as never, d);
    expect(res.status).toBe(204);
    expect(member(t, 'u-ad')?.license_status).toBe('suspended');
    expect(t.users.find((u) => u.id === 'u-ad')?.suspended_at).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('control: DELETE of an agent goes through (204)', async () => {
    const t = tables();
    const db = makeDb(t);
    const { d } = deps();
    const res = await users.handleDeleteUser('u-ag', AUTH as never, db.client as never, d);
    expect(res.status).toBe(204);
    expect(member(t, 'u-ag')?.license_status).toBe('suspended');
  });
});

// ---------------------------------------------------------------------------
// J5: the email de-dupe counts the trigger's own row
// ---------------------------------------------------------------------------

describe('notifyLastAdminKept de-dupe (J5)', () => {
  const log = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `b${i}`, organization_id: ORG, action: LAST_ADMIN_LOG_ACTION, created_at: new Date(NOW - i * 1000).toISOString(),
  }));

  it('only the current row in the window: sends', async () => {
    const db = makeDb(tables({ billing_change_log: log(1) }));
    const { d, fetch } = deps();
    await expect(notifyLastAdminKept(db.client, d, { orgId: ORG, personLabel: 'x', kind: 'demote', source: 'scim' })).resolves.toBe('sent');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('an earlier row in the window: de-duped, no send', async () => {
    const db = makeDb(tables({ billing_change_log: log(2) }));
    const { d, fetch } = deps();
    await expect(notifyLastAdminKept(db.client, d, { orgId: ORG, personLabel: 'x', kind: 'demote', source: 'scim' })).resolves.toBe('deduped');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an earlier row outside the 24 h window does not de-dupe', async () => {
    const rows = log(1).concat([{ id: 'old', organization_id: ORG, action: LAST_ADMIN_LOG_ACTION, created_at: new Date(NOW - 25 * 3600 * 1000).toISOString() }]);
    const db = makeDb(tables({ billing_change_log: rows }));
    const { d } = deps();
    await expect(notifyLastAdminKept(db.client, d, { orgId: ORG, personLabel: 'x', kind: 'demote', source: 'scim' })).resolves.toBe('sent');
  });

  it('never throws: a portal error is "failed"', async () => {
    const db = makeDb(tables({ billing_change_log: log(1) }));
    const { d } = deps();
    d.fetch = async () => { throw new Error('down'); };
    await expect(notifyLastAdminKept(db.client, d, { orgId: ORG, personLabel: 'x', kind: 'demote', source: 'scim' })).resolves.toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// directory sync
// ---------------------------------------------------------------------------

describe('directory sync and the last admin', () => {
  const IDP = { id: 'idp-1', organization_id: ORG, provider_type: 'azure_ad', client_id: null, client_secret_encrypted: null,
    service_account_key_encrypted: null, issuer_url: null, is_active: true, attribute_mapping: null };
  const ORG_ROW = { id: ORG, default_member_role: 'agent' };

  function dirTables() {
    const t = tables();
    // The only admin and an agent were both provisioned by directory sync; the IdP no longer lists either.
    t.organization_members = [
      { id: 'm-ad', organization_id: ORG, user_id: 'u-ad', role: 'admin', license_status: 'active', provisioned_by: 'directory_sync', group_sync_enabled: null, scim_synced_at: null },
      { id: 'm-it', organization_id: ORG, user_id: 'u-it', role: 'it_admin', license_status: 'active', provisioned_by: 'invite', group_sync_enabled: false, scim_synced_at: null },
      { id: 'm-ag', organization_id: ORG, user_id: 'u-ag', role: 'agent', license_status: 'active', provisioned_by: 'directory_sync', group_sync_enabled: null, scim_synced_at: null },
    ];
    t.users = t.users.map((u) => ({ ...u, oauth_id: null, scim_external_id: null }));
    return t;
  }

  it('the last admin removed from the directory stays active, their users row is not suspended, counted, one email', async () => {
    const t = dirTables();
    const db = makeDb(t);
    const { d, fetch } = deps();
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: async () => [], notifyDeps: d });
    expect(member(t, 'u-ad')?.license_status).toBe('active');
    expect(t.users.find((u) => u.id === 'u-ad')?.suspended_at).toBeNull();
    expect(member(t, 'u-ag')?.license_status).toBe('suspended');
    expect(t.users.find((u) => u.id === 'u-ag')?.suspended_at).not.toBeNull();
    expect(r).toMatchObject({ suspended: 1, skipped_last_admin: 1, error: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetch.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ kind: 'deactivate', source: 'directory_sync' });
  });

  it('a second run within 24 h keeps the admin again and sends no second email', async () => {
    const t = dirTables();
    const db = makeDb(t);
    const { d, fetch } = deps();
    await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: async () => [], notifyDeps: d });
    member(t, 'u-ad')!.scim_synced_at = '2026-10-21T11:00:00.000Z';
    await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: async () => [], notifyDeps: d });
    expect(member(t, 'u-ad')?.license_status).toBe('active');
    // second run: the trigger wrote a second log row, so the de-dupe holds the email back
    expect(t.billing_change_log).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Group mapping demotes the last admin (kept branches; SR review 09a5d79a)
// ---------------------------------------------------------------------------

describe('a group mapping that would demote the last admin is kept', () => {
  const MAPPING = { group_sync_enabled: true, group_role_mapping: { 'idp-group-agents': 'agent' }, default_role: 'agent' };
  const IDP_ROW = { id: 'idp-1', organization_id: ORG, is_active: true, attribute_mapping: MAPPING };

  it('SCIM PATCH: groups resolve the only admin to agent: 200, role stays admin, logged last_admin_kept, one demote email', async () => {
    const t = tables({ organization_identity_providers: [IDP_ROW] });
    const db = makeDb(t);
    const { d, fetch } = deps();
    const req = new Request(`${BASE}/scim/v2/Users/u-ad`, {
      method: 'PATCH',
      body: JSON.stringify({ schemas: [], groups: [{ value: 'idp-group-agents' }], Operations: [{ op: 'replace', path: 'displayName', value: 'Ada Admin' }] }),
    });
    const res = await users.handlePatchUser(req, 'u-ad', AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(200);
    expect(member(t, 'u-ad')?.role).toBe('admin');
    expect(member(t, 'u-ad')?.license_status).toBe('active');
    expect(t.scim_sync_log.map((l) => [l.operation, l.response_status, l.error_message])).toContainEqual(['UPDATE', 200, LAST_ADMIN_KEPT]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetch.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ kind: 'demote', source: 'scim' });
  });

  it('SCIM PATCH control: the same groups on an admin who is not the last one demote them; nothing kept, no email', async () => {
    const t = tables({ organization_identity_providers: [IDP_ROW] });
    t.organization_members.push({ id: 'm-ad2', organization_id: ORG, user_id: 'u-ad2', role: 'admin', license_status: 'active', scim_synced_at: null });
    t.users.push({ id: 'u-ad2', email: 'admin2@example.test', suspended_at: null });
    const db = makeDb(t);
    const { d, fetch } = deps();
    const req = new Request(`${BASE}/scim/v2/Users/u-ad`, {
      method: 'PATCH',
      body: JSON.stringify({ schemas: [], groups: [{ value: 'idp-group-agents' }], Operations: [{ op: 'replace', path: 'displayName', value: 'Ada Admin' }] }),
    });
    const res = await users.handlePatchUser(req, 'u-ad', AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(200);
    expect(member(t, 'u-ad')?.role).toBe('agent');
    expect(t.scim_sync_log.some((l) => l.error_message === LAST_ADMIN_KEPT)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('directory sync: groups resolve the only admin to agent: role stays admin, skipped_last_admin counted, one demote email', async () => {
    const t = tables();
    t.organization_members = [
      { id: 'm-ad', organization_id: ORG, user_id: 'u-ad', role: 'admin', license_status: 'active', provisioned_by: 'directory_sync', group_sync_enabled: null, scim_synced_at: null },
      { id: 'm-it', organization_id: ORG, user_id: 'u-it', role: 'it_admin', license_status: 'active', provisioned_by: 'invite', group_sync_enabled: false, scim_synced_at: null },
    ];
    t.users = t.users.map((u) => ({ ...u, oauth_id: null, scim_external_id: null }));
    const db = makeDb(t);
    const { d, fetch } = deps();
    const idp = { id: 'idp-1', organization_id: ORG, provider_type: 'azure_ad', client_id: null, client_secret_encrypted: null,
      service_account_key_encrypted: null, issuer_url: null, is_active: true, attribute_mapping: MAPPING };
    const providerUser = { externalId: 'ext-ad', email: 'admin@example.test', firstName: null, lastName: null, displayName: null, groups: ['idp-group-agents'] };
    const r = await sync.syncOrganization(db.client, ORG, { id: ORG, default_member_role: 'agent' }, idp, { fetchUsers: async () => [providerUser], notifyDeps: d });
    expect(member(t, 'u-ad')?.role).toBe('admin');
    expect(r).toMatchObject({ skipped_last_admin: 1, error: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetch.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ kind: 'demote', source: 'directory_sync' });
  });
});

// ---------------------------------------------------------------------------
// SCIM create: userName, then emails[] (founder 2026-10-21)
// ---------------------------------------------------------------------------

describe('SCIM create matches an existing account by userName, then emails[]', () => {
  const postReq = (body: Row) => new Request(`${BASE}/scim/v2/Users`, { method: 'POST', body: JSON.stringify({ schemas: [], ...body }) });

  function createTables() {
    const t = tables();
    t.users.push({ id: 'u-mail', email: 'pat@example.test', suspended_at: null });
    return t;
  }

  it('userName = UPN (no account), emails[0] = mail (an account): the existing account is added, no new users row', async () => {
    const t = createTables();
    const db = makeDb(t, { authEmails: { 'u-mail': 'pat@example.test' } });
    const { d } = deps();
    const res = await users.handleCreateUser(
      postReq({ userName: 'pat.upn@corp.example.test', externalId: 'oid-1', emails: [{ value: 'Pat@Example.test', primary: true, type: 'work' }] }),
      AUTH as never, db.client as never, BASE, d,
    );
    expect(res.status).toBe(201);
    expect(db.writes.filter((w) => w.table === 'users' && w.op === 'insert')).toHaveLength(0);
    const inserted = db.writes.filter((w) => w.table === 'organization_members' && w.op === 'insert');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].payload).toMatchObject({ user_id: 'u-mail', provisioned_by: 'scim' });
    expect(db.rpcCalls).toEqual(['pat.upn@corp.example.test', 'pat@example.test']);
  });

  it('userName is tried first: when it names an account, emails[] is not consulted', async () => {
    const t = createTables();
    t.users.push({ id: 'u-upn', email: 'pat.upn@corp.example.test', suspended_at: null });
    const db = makeDb(t, { authEmails: { 'u-mail': 'pat@example.test', 'u-upn': 'pat.upn@corp.example.test' } });
    const { d } = deps();
    const res = await users.handleCreateUser(
      postReq({ userName: 'pat.upn@corp.example.test', emails: [{ value: 'pat@example.test', primary: true }] }),
      AUTH as never, db.client as never, BASE, d,
    );
    expect(res.status).toBe(201);
    expect(db.writes.find((w) => w.table === 'organization_members' && w.op === 'insert')?.payload).toMatchObject({ user_id: 'u-upn' });
    expect(db.rpcCalls).toEqual(['pat.upn@corp.example.test']);
  });

  it('an open invitation sent to the mail address is claimed when userName is the UPN', async () => {
    const t = createTables();
    t.organization_members.push({ id: 'm-inv', organization_id: ORG, user_id: null, role: 'broker', license_status: 'pending', invited_email: 'Pat@example.test', provisioning_metadata: null });
    const db = makeDb(t, { authEmails: { 'u-mail': 'pat@example.test' } });
    const { d } = deps();
    const res = await users.handleCreateUser(
      postReq({ userName: 'pat.upn@corp.example.test', emails: [{ value: 'pat@example.test' }] }),
      AUTH as never, db.client as never, BASE, d,
    );
    expect(res.status).toBe(201);
    expect(t.organization_members.find((m) => m.id === 'm-inv')).toMatchObject({ user_id: 'u-mail', license_status: 'active', role: 'broker' });
  });

  it('names are never matched', async () => {
    const t = createTables();
    const db = makeDb(t, { authEmails: { 'u-mail': 'pat@example.test' } });
    const { d } = deps();
    await users.handleCreateUser(
      postReq({ userName: 'someone@corp.example.test', displayName: 'pat@example.test', name: { givenName: 'pat@example.test' } }),
      AUTH as never, db.client as never, BASE, d,
    );
    expect(db.rpcCalls).toEqual(['someone@corp.example.test']);
  });

  it('candidate order: userName, primary, work, the rest; lower-cased, de-duplicated, addresses only', () => {
    expect(users.scimEmailCandidates({
      userName: 'U@x.test',
      emails: [{ value: 'other@x.test' }, { value: 'work@x.test', type: 'work' }, { value: 'p@x.test', primary: true }, { value: 'u@x.test' }, { value: 'not-an-address' }],
    })).toEqual(['u@x.test', 'p@x.test', 'work@x.test', 'other@x.test']);
  });
});
