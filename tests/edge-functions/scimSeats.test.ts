/**
 * @jest-environment node
 *
 * BACKLOG-3851 PR-2c: SCIM seat refusals in the scim Edge Function handlers.
 *
 * Lives under tests/ because jest's CI testMatch runs <rootDir>/tests/** and not
 * supabase/functions/**. The database client is an in-memory fake that answers ONLY the
 * columns a query selects (so a handler that forgets to select a column sees undefined),
 * and returns the seat trigger's refusal (P0001 seat_limit_reached) or the auth.users
 * foreign-key error (23503) where the real database does. Shapes transcribed from the
 * NAS venue (supabase/tests/backlog-3851, control c19): an existing Keepr person has an
 * auth.users row; a brand-new email gets a public.users row whose membership the
 * auth.users key refuses. fetch is injected: no network.
 */

jest.mock('jsr:@supabase/supabase-js@2', () => ({}), { virtual: true });

import {
  SEAT_LIMIT_ERROR,
  type SeatNotifyDeps,
} from '../../supabase/functions/scim/shared/seatLimit';

// users.ts is Deno source (jsr: and .ts-suffixed imports, the Deno global in auth.ts), which
// the repo's tsc configs cannot compile; jest loads it fine. So it is required, not
// imported, and its three handler signatures are declared here.
type Handler = (...args: unknown[]) => Promise<Response>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const users = require('../../supabase/functions/scim/handlers/users') as {
  handleCreateUser: Handler;
  handlePatchUser: Handler;
  handleDeleteUser: Handler;
};
const { handleCreateUser, handlePatchUser, handleDeleteUser } = users;

// ---------------------------------------------------------------------------
// In-memory fake of the PostgREST client
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Err = { code?: string; message: string } | null;
type Write = { table: string; op: 'insert' | 'update' | 'delete'; payload?: Row; rows: Row[] };

interface FakeOpts {
  /** Seat trigger: the org is full, so a membership write that takes a seat is refused. */
  full?: boolean;
  /** Users ids that have an auth.users row (existing Keepr accounts). */
  authIds?: string[];
  /**
   * Sign-in (auth.users) email per user id, where it differs from users.email. An id in
   * authIds without an entry here signs in with its users.email.
   */
  authEmails?: Record<string, string>;
  /** Force an error on the next write to a table/op. */
  failWrite?: { table: string; op: 'insert' | 'update' | 'delete'; error: Err };
}

const ORG = 'org-1';
const NOW = Date.parse('2026-10-16T12:00:00Z');

function holdsSeat(r: Row): boolean {
  if (r.license_status === 'active') return true;
  if (r.license_status !== 'pending') return false;
  if (r.user_id) return true;
  if (!r.invitation_expires_at) return true;
  return Date.parse(String(r.invitation_expires_at)) >= NOW;
}

function makeDb(tables: Tables, opts: FakeOpts = {}) {
  const writes: Write[] = [];
  let seq = 0;

  function from(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let cols = '*';
    let payload: Row | undefined;
    let returning: string | null = null;
    let head = false;
    let wantCount = false;
    const filters: Array<(r: Row) => boolean> = [];

    const project = (r: Row, c: string): Row => {
      if (c.trim() === '*') return { ...r };
      const out: Row = {};
      for (const k of c.split(',').map((x) => x.trim())) out[k] = r[k];
      return out;
    };

    const run = (): { data: unknown; error: Err; count?: number } => {
      const rows = (tables[table] ??= []);
      if (op === 'select') {
        const hit = rows.filter((r) => filters.every((f) => f(r)));
        if (head) return { data: null, error: null, count: hit.length };
        return { data: hit.map((r) => project(r, cols)), error: null, count: wantCount ? hit.length : undefined };
      }
      if (opts.failWrite && opts.failWrite.table === table && opts.failWrite.op === op) {
        const error = opts.failWrite.error;
        opts.failWrite = undefined;
        writes.push({ table, op, payload, rows: [] });
        return { data: null, error };
      }
      if (op === 'insert') {
        const row: Row = { id: `${table}-new-${++seq}`, ...payload };
        if (table === 'organization_members') {
          if (opts.full && holdsSeat(row)) {
            writes.push({ table, op, payload, rows: [] });
            return { data: null, error: { code: 'P0001', message: 'seat_limit_reached' } };
          }
          if (row.user_id && !(opts.authIds ?? []).includes(String(row.user_id))) {
            writes.push({ table, op, payload, rows: [] });
            return {
              data: null,
              error: { code: '23503', message: 'violates foreign key constraint "organization_members_user_id_fkey"' },
            };
          }
        }
        if (table === 'scim_sync_log') row.created_at = new Date(NOW).toISOString();
        rows.push(row);
        writes.push({ table, op, payload, rows: [row] });
        return { data: returning ? [project(row, returning)] : row, error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        if (table === 'organization_members' && opts.full) {
          for (const r of hit) {
            const next = { ...r, ...payload };
            if (holdsSeat(next) && !holdsSeat(r)) {
              writes.push({ table, op, payload, rows: [] });
              return { data: null, error: { code: 'P0001', message: 'seat_limit_reached' } };
            }
          }
        }
        for (const r of hit) Object.assign(r, payload);
        writes.push({ table, op, payload, rows: hit.map((r) => ({ ...r })) });
        return { data: returning ? hit.map((r) => project(r, returning as string)) : null, error: null };
      }
      // delete
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
        wantCount = !!o?.count;
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
      ilike: () => b,
      range: () => b,
      order: () => b,
      maybeSingle: async () => {
        const r = run();
        const d = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
        return { data: d, error: r.error };
      },
      single: async () => {
        const r = run();
        const d = Array.isArray(r.data) ? r.data[0] : r.data;
        return { data: d ?? null, error: r.error ?? (d ? null : { message: 'no rows' }) };
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(run()).then(res, rej),
    };
    return b;
  }

  // user_id_for_auth_email (migration 20261016070000), transcribed: the auth-backed
  // account whose sign-in email matches (NULL if more than one); with none, a users row
  // with no auth record whose stored email matches (NULL if more than one).
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  async function rpc(fn: string, args: Record<string, unknown>) {
    rpcCalls.push({ fn, args });
    if (fn !== 'user_id_for_auth_email') return { data: null, error: null };
    const e = String(args.p_email ?? '').trim().toLowerCase();
    const authIds = opts.authIds ?? [];
    const users = tables.users ?? [];
    const authHits = authIds.filter((id) => {
      const signIn = opts.authEmails?.[id] ?? users.find((u) => u.id === id)?.email;
      return typeof signIn === 'string' && signIn.trim().toLowerCase() === e;
    });
    if (authHits.length > 1) return { data: null, error: null };
    if (authHits.length === 1) {
      return { data: users.some((u) => u.id === authHits[0]) ? authHits[0] : null, error: null };
    }
    const rows = users.filter(
      (u) => !authIds.includes(String(u.id)) && String(u.email ?? '').trim().toLowerCase() === e,
    );
    return { data: rows.length === 1 ? rows[0].id : null, error: null };
  }

  return { client: { from, rpc }, writes, tables, rpcCalls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTH = { orgId: ORG, tokenId: 'tok-1', permissions: { canCreate: true, canUpdate: true, canDelete: true } };
const BASE = 'https://proj.supabase.test/functions/v1/scim';

function baseTables(extra: Partial<Tables> = {}): Tables {
  return {
    organizations: [
      { id: ORG, name: 'Happyhomey Test 2c', max_seats: 2, default_member_role: 'agent', personal_owner_user_id: null },
      { id: 'org-other', name: 'Other Brokerage', max_seats: 5, personal_owner_user_id: null },
      { id: 'org-personal-p', name: 'Personal', max_seats: null, personal_owner_user_id: 'u-p' },
    ],
    users: [
      { id: 'u-it', email: 'it@example.test' },
      { id: 'u-ad', email: 'admin@example.test' },
      {
        id: 'u-p',
        email: 'person@example.test',
        display_name: 'Seat Fixture',
        suspended_at: null,
      },
    ],
    organization_members: [
      { id: 'm-it', organization_id: ORG, user_id: 'u-it', role: 'it_admin', license_status: 'active', invitation_expires_at: null },
      { id: 'm-ad', organization_id: ORG, user_id: 'u-ad', role: 'admin', license_status: 'active', invitation_expires_at: null },
    ],
    scim_sync_log: [],
    organization_identity_providers: [],
    ...extra,
  };
}

function deps(overrides: Partial<SeatNotifyDeps> = {}) {
  const fetch = jest.fn(async () => new Response('{"success":true}', { status: 200 }));
  const d: SeatNotifyDeps = {
    fetch,
    getEnv: (k: string) => ({ BROKER_PORTAL_URL: 'https://portal.test', INTERNAL_API_SECRET: 'internal-secret' } as Record<string, string>)[k],
    now: () => NOW,
    timeoutMs: 50,
    ...overrides,
  };
  return { d, fetch: (overrides.fetch as jest.Mock | undefined) ?? fetch };
}

function postReq(userName: string, extra: Row = {}) {
  return new Request(`${BASE}/scim/v2/Users`, {
    method: 'POST',
    body: JSON.stringify({ schemas: [], userName, externalId: `ext-${userName}`, ...extra }),
  });
}

function patchReq(ops: unknown[]) {
  return new Request(`${BASE}/scim/v2/Users/u-p`, { method: 'PATCH', body: JSON.stringify({ schemas: [], Operations: ops }) });
}

const memberWrites = (w: Write[]) => w.filter((x) => x.table === 'organization_members');
const userWrites = (w: Write[]) => w.filter((x) => x.table === 'users');

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// POST, existing Keepr person (S1)
// ---------------------------------------------------------------------------

describe('POST existing person', () => {
  it('free seat: inserts an active scim membership, then updates the users row; 201', async () => {
    const t = baseTables({ users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-q', email: 'q@example.test' }] });
    const db = makeDb(t, { authIds: ['u-q'] });
    const { d, fetch } = deps();
    const res = await handleCreateUser(postReq('Q@example.test'), AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(201);
    const writes = db.writes.filter((w) => w.table !== 'scim_sync_log');
    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual(['organization_members:insert', 'users:update']);
    expect(writes[0].payload).toMatchObject({ user_id: 'u-q', license_status: 'active', provisioned_by: 'scim' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('full org: 403 seat_limit_reached, no membership, users row untouched, one email to the IT admin', async () => {
    const t = baseTables({ users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-q', email: 'q@example.test', display_name: 'Quinn Q' }] });
    const db = makeDb(t, { full: true, authIds: ['u-q'] });
    const { d, fetch } = deps();
    const res = await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe('403');
    expect(body.detail.startsWith('seat_limit_reached')).toBe(true);
    expect(body.detail).not.toMatch(/retry will add|next retry adds|will add this user/i);
    expect('scimType' in body).toBe(false);
    expect(userWrites(db.writes)).toEqual([]);
    expect(t.organization_members.some((m) => m.user_id === 'u-q')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://portal.test/api/email/seat-limit-reached');
    expect((init.headers as Record<string, string>)['x-api-secret']).toBe('internal-secret');
    expect(JSON.parse(String(init.body))).toEqual({
      recipients: ['it@example.test'], personLabel: 'q@example.test', brokerageName: 'Happyhomey Test 2c',
      used: 2, maxSeats: 2, kind: 'add',
    });
    const log = t.scim_sync_log.filter((r) => r.response_status === 403);
    expect(log).toHaveLength(1);
    expect(log[0].error_message).toBe(SEAT_LIMIT_ERROR);
  });

  it('claims the person\'s unclaimed invite in this org instead of inserting beside it', async () => {
    const t = baseTables({
      users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-q', email: 'q@example.test' }],
    });
    t.organization_members.push({ id: 'm-inv', organization_id: ORG, user_id: null, role: 'broker', license_status: 'pending',
      invited_email: ' Q@Example.test', invitation_token: 'tok', invitation_expires_at: '2026-10-20T00:00:00Z' });
    t.organizations[0].max_seats = 3; // it_admin + admin + the live invite = full
    const db = makeDb(t, { full: true, authIds: ['u-q'] });
    const { d } = deps();
    const res = await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(201);
    const mw = memberWrites(db.writes);
    expect(mw.map((w) => w.op)).toEqual(['update']);
    expect(mw[0].rows[0]).toMatchObject({ id: 'm-inv', user_id: 'u-q', license_status: 'active', role: 'broker',
      provisioned_by: 'scim', invitation_token: null });
  });

  // BACKLOG-3851 PR-2f C13: an invitation sent WITHOUT a license ('unassigned', user_id null).
  // Founder Q-1 = (b): a SCIM claim takes a license. Shapes from keepr-test (SR L4): free seat ->
  // the invite's own row active/claimed; full -> P0001 seat_limit_reached, row unchanged.
  const UNLICENSED_INVITE = { id: 'm-unl', organization_id: ORG, user_id: null, role: 'broker', license_status: 'unassigned',
    invited_email: 'Q@example.test', invitation_token: 'tok-unl', invitation_expires_at: '2026-10-20T00:00:00Z' };
  const qTables = () => baseTables({ users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-q', email: 'q@example.test' }] });

  it('C13(i) free seat: claims the unlicensed invite itself, which becomes active; exactly one row for the email', async () => {
    const t = qTables();
    t.organization_members.push({ ...UNLICENSED_INVITE });
    const db = makeDb(t, { authIds: ['u-q'] });
    const res = await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(201);
    expect(memberWrites(db.writes).map((w) => w.op)).toEqual(['update']);
    const rows = t.organization_members.filter((m) => m.user_id === 'u-q' || String(m.invited_email ?? '').toLowerCase() === 'q@example.test');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm-unl', user_id: 'u-q', license_status: 'active', role: 'broker', invitation_token: null });
  });

  it('C13(ii) full org: 403 + one notice, the unlicensed invite stays unassigned and unclaimed, no new row', async () => {
    const t = qTables();
    t.organization_members.push({ ...UNLICENSED_INVITE });
    const before = t.organization_members.length;
    const db = makeDb(t, { full: true, authIds: ['u-q'] });
    const { d, fetch } = deps();
    const res = await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(t.organization_members).toHaveLength(before);
    expect(t.organization_members.find((m) => m.id === 'm-unl')).toMatchObject({ user_id: null, license_status: 'unassigned' });
    expect(userWrites(db.writes)).toEqual([]);
  });

  it('C13(iii) a licensed pending invite is claimed as before (active)', async () => {
    const t = qTables();
    t.organization_members.push({ ...UNLICENSED_INVITE, id: 'm-lic', license_status: 'pending' });
    const db = makeDb(t, { authIds: ['u-q'] });
    const res = await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(201);
    expect(t.organization_members.find((m) => m.id === 'm-lic')).toMatchObject({ user_id: 'u-q', license_status: 'active' });
    expect(t.organization_members.filter((m) => m.user_id === 'u-q')).toHaveLength(1);
  });

  it('an EXPIRED invite in a full org is a seat refusal (403), the invite stays unclaimed', async () => {
    const t = baseTables({ users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-q', email: 'q@example.test' }] });
    t.organization_members.push({ id: 'm-inv', organization_id: ORG, user_id: null, role: 'agent', license_status: 'pending',
      invited_email: 'q@example.test', invitation_expires_at: '2026-10-01T00:00:00Z' });
    const db = makeDb(t, { full: true, authIds: ['u-q'] });
    const res = await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(403);
    expect(t.organization_members.find((m) => m.id === 'm-inv')?.user_id).toBeNull();
    expect(userWrites(db.writes)).toEqual([]);
  });

  it('already in another brokerage: 409 uniqueness, nothing written, no email', async () => {
    const t = baseTables({ users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-q', email: 'q@example.test' }] });
    t.organization_members.push({ id: 'm-o', organization_id: 'org-other', user_id: 'u-q', role: 'agent', license_status: 'suspended' });
    const db = makeDb(t, { authIds: ['u-q'] });
    const { d, fetch } = deps();
    const res = await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.scimType).toBe('uniqueness');
    expect(body.detail).toMatch(/^already_placed/);
    expect(db.writes.filter((w) => w.table !== 'scim_sync_log')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Q-F4 (b): only their own personal account: 409, "must accept an invitation from the brokerage", nothing written', async () => {
    const t = baseTables();
    t.organization_members.push({ id: 'm-pp', organization_id: 'org-personal-p', user_id: 'u-p', role: 'admin', license_status: 'active' });
    t.organization_members.push({ id: 'm-inv', organization_id: ORG, user_id: null, role: 'agent', license_status: 'pending',
      invited_email: 'person@example.test', invitation_expires_at: '2026-10-20T00:00:00Z' });
    const db = makeDb(t, { authIds: ['u-p'] });
    const { d, fetch } = deps();
    const res = await handleCreateUser(postReq('person@example.test'), AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.detail).toContain('this person must accept an invitation from the brokerage');
    expect(db.writes.filter((w) => w.table !== 'scim_sync_log')).toEqual([]);
    expect(t.organization_members.find((m) => m.id === 'm-inv')?.user_id).toBeNull();
    expect(t.organization_members.some((m) => m.id === 'm-pp')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a non-seat membership error is a 500, and the users row is untouched', async () => {
    const t = baseTables({ users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-q', email: 'q@example.test' }] });
    const db = makeDb(t, { authIds: ['u-q'], failWrite: { table: 'organization_members', op: 'insert', error: { code: '23514', message: 'check' } } });
    const res = await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(500);
    expect(userWrites(db.writes)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST, brand-new email (S2; provisioning a new person is BACKLOG-3986)
// ---------------------------------------------------------------------------

describe('POST brand-new email', () => {
  it('free org: the auth.users key refuses the membership -> 500, the fresh users row is removed, never 201', async () => {
    const t = baseTables();
    const db = makeDb(t, { authIds: [] });
    const { d, fetch } = deps();
    const res = await handleCreateUser(postReq('new@example.test'), AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(500);
    expect(t.users.some((u) => u.email === 'new@example.test')).toBe(false);
    expect(userWrites(db.writes).map((w) => w.op)).toEqual(['insert', 'delete']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('full org: the seat rule refuses first -> 403 + email, the fresh users row is removed', async () => {
    const t = baseTables();
    const db = makeDb(t, { full: true, authIds: [] });
    const { d, fetch } = deps();
    const res = await handleCreateUser(postReq('new@example.test', { name: { givenName: 'Nia', familyName: 'New' } }), AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(403);
    expect(t.users.some((u) => u.email === 'new@example.test')).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).personLabel).toBe('Nia New');
  });
});

// ---------------------------------------------------------------------------
// Email: recipients, de-dupe, delivery failure
// ---------------------------------------------------------------------------

describe('seat email', () => {
  const fullPost = async (t: Tables, dd: SeatNotifyDeps) => {
    t.users.push({ id: 'u-q', email: 'q@example.test' });
    const db = makeDb(t, { full: true, authIds: ['u-q'] });
    return handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, dd);
  };

  it('no active IT admin: falls back to the active admins', async () => {
    const t = baseTables();
    t.organization_members[0].license_status = 'suspended';
    const { d, fetch } = deps();
    expect((await fullPost(t, d)).status).toBe(403);
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).recipients).toEqual(['admin@example.test']);
  });

  it('a seat refusal already logged in the last 24 h: no second email', async () => {
    const t = baseTables();
    t.scim_sync_log.push({ organization_id: ORG, response_status: 403, error_message: SEAT_LIMIT_ERROR,
      created_at: new Date(NOW - 60 * 60 * 1000).toISOString() });
    const { d, fetch } = deps();
    expect((await fullPost(t, d)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a refusal older than 24 h does not suppress the email', async () => {
    const t = baseTables();
    t.scim_sync_log.push({ organization_id: ORG, response_status: 403, error_message: SEAT_LIMIT_ERROR,
      created_at: new Date(NOW - 25 * 60 * 60 * 1000).toISOString() });
    const { d, fetch } = deps();
    expect((await fullPost(t, d)).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('portal call fails, hangs past the timeout, or is not configured: still 403', async () => {
    const failing = jest.fn(async () => { throw new Error('network'); });
    expect((await fullPost(baseTables(), deps({ fetch: failing }).d)).status).toBe(403);
    const hanging = jest.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    expect((await fullPost(baseTables(), deps({ fetch: hanging }).d)).status).toBe(403);
    expect(hanging).toHaveBeenCalledTimes(1);
    const unset = deps({ getEnv: () => undefined });
    expect((await fullPost(baseTables(), unset.d)).status).toBe(403);
    expect(unset.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH and DELETE
// ---------------------------------------------------------------------------

describe('PATCH active', () => {
  const withMember = (status: string, full = false) => {
    const t = baseTables();
    t.users.find((u) => u.id === 'u-p')!.suspended_at = status === 'suspended' ? '2026-10-01T00:00:00Z' : null;
    t.organization_members.push({ id: 'm-p', organization_id: ORG, user_id: 'u-p', role: 'agent', license_status: status,
      group_sync_enabled: false });
    return { t, db: makeDb(t, { full, authIds: ['u-p', 'u-it', 'u-ad'] }) };
  };
  const active = (v: unknown) => [{ op: 'replace', path: 'active', value: v }];

  it('active:true on an unassigned member assigns nothing (no license_status write)', async () => {
    const { t, db } = withMember('unassigned');
    const res = await handlePatchUser(patchReq(active(true)), 'u-p', AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(200);
    expect(memberWrites(db.writes).some((w) => 'license_status' in (w.payload ?? {}))).toBe(false);
    expect(t.organization_members.find((m) => m.id === 'm-p')?.license_status).toBe('unassigned');
  });

  it('active:true on a pending member leaves it pending', async () => {
    const { db } = withMember('pending');
    await handlePatchUser(patchReq(active('True')), 'u-p', AUTH as never, db.client as never, BASE, deps().d);
    expect(memberWrites(db.writes).some((w) => 'license_status' in (w.payload ?? {}))).toBe(false);
  });

  it('re-activation with a free seat: active, users.suspended_at cleared', async () => {
    const { t, db } = withMember('suspended');
    const res = await handlePatchUser(patchReq(active(true)), 'u-p', AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(200);
    expect(t.organization_members.find((m) => m.id === 'm-p')?.license_status).toBe('active');
    expect(t.users.find((u) => u.id === 'u-p')?.suspended_at).toBeNull();
  });

  it('re-activation in a full org: 403, still suspended, users row not written, email excludes the person', async () => {
    const { t, db } = withMember('suspended', true);
    t.organization_members.push({ id: 'm-it2', organization_id: ORG, user_id: 'u-p2', role: 'it_admin', license_status: 'active' });
    t.users.push({ id: 'u-p2', email: 'it2@example.test' });
    const { d, fetch } = deps();
    const res = await handlePatchUser(patchReq([{ op: 'replace', value: { active: true, displayName: 'New Name' } }]), 'u-p',
      AUTH as never, db.client as never, BASE, d);
    expect(res.status).toBe(403);
    expect((await res.json()).detail.startsWith('seat_limit_reached')).toBe(true);
    expect(t.organization_members.find((m) => m.id === 'm-p')?.license_status).toBe('suspended');
    expect(userWrites(db.writes)).toEqual([]);
    expect(t.users.find((u) => u.id === 'u-p')?.suspended_at).toBe('2026-10-01T00:00:00Z');
    const sent = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.kind).toBe('reactivate');
    expect(sent.personLabel).toBe('Seat Fixture');
    expect(sent.recipients).toEqual(['it@example.test', 'it2@example.test']);
  });

  it('active:false on an unassigned member suspends it', async () => {
    const { t, db } = withMember('unassigned');
    const res = await handlePatchUser(patchReq(active(false)), 'u-p', AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(200);
    expect(t.organization_members.find((m) => m.id === 'm-p')?.license_status).toBe('suspended');
  });

  it('a non-seat membership error is a 500 and the users row is not written', async () => {
    const t = baseTables();
    t.organization_members.push({ id: 'm-p', organization_id: ORG, user_id: 'u-p', role: 'agent', license_status: 'active' });
    const db = makeDb(t, { failWrite: { table: 'organization_members', op: 'update', error: { code: 'XX000', message: 'boom' } } });
    const res = await handlePatchUser(patchReq(active(false)), 'u-p', AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(500);
    expect(userWrites(db.writes)).toEqual([]);
  });
});

describe('DELETE', () => {
  it('suspends the membership and the user; 204', async () => {
    const t = baseTables();
    t.organization_members.push({ id: 'm-p', organization_id: ORG, user_id: 'u-p', role: 'agent', license_status: 'unassigned' });
    const db = makeDb(t);
    const res = await handleDeleteUser('u-p', AUTH as never, db.client as never);
    expect(res.status).toBe(204);
    expect(t.organization_members.find((m) => m.id === 'm-p')?.license_status).toBe('suspended');
    expect(t.users.find((u) => u.id === 'u-p')?.suspended_at).toBeTruthy();
  });

  it('a membership error is a 500, the user is not suspended', async () => {
    const t = baseTables();
    t.organization_members.push({ id: 'm-p', organization_id: ORG, user_id: 'u-p', role: 'agent', license_status: 'active' });
    const db = makeDb(t, { failWrite: { table: 'organization_members', op: 'update', error: { code: 'XX000', message: 'boom' } } });
    const res = await handleDeleteUser('u-p', AUTH as never, db.client as never);
    expect(res.status).toBe(500);
    expect(t.users.find((u) => u.id === 'u-p')?.suspended_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3998: the existing person is found by sign-in email, not by users.email
// ---------------------------------------------------------------------------

describe('POST existing person: lookup by sign-in email (BACKLOG-3998)', () => {
  it('asks user_id_for_auth_email with the userName and never filters users by email', async () => {
    const t = baseTables({ users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-q', email: 'q@example.test' }] });
    const db = makeDb(t, { authIds: ['u-q'] });
    const res = await handleCreateUser(postReq('Q@example.test'), AUTH as never, db.client as never, BASE, deps().d);
    expect(res.status).toBe(201);
    expect(db.rpcCalls).toEqual([{ fn: 'user_id_for_auth_email', args: { p_email: 'q@example.test' } }]);
    expect(memberWrites(db.writes)[0].payload).toMatchObject({ user_id: 'u-q' });
  });

  it('a users row holding the address whose sign-in email differs is not that person', async () => {
    const t = baseTables({ users: [...baseTables().users.filter((u) => u.id !== 'u-p'), { id: 'u-x', email: 'q@example.test' }] });
    const db = makeDb(t, { authIds: ['u-x'], authEmails: { 'u-x': 'someone-else@example.test' } });
    await handleCreateUser(postReq('q@example.test'), AUTH as never, db.client as never, BASE, deps().d);
    expect(memberWrites(db.writes).some((w) => w.payload?.user_id === 'u-x')).toBe(false);
    expect(userWrites(db.writes).some((w) => w.rows.some((r) => r.id === 'u-x'))).toBe(false);
  });
});
