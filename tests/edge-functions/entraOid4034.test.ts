/**
 * @jest-environment node
 *
 * BACKLOG-4034: directory sync finds a person by the Entra object id that Supabase Auth
 * stores on the person's azure identity (tenant id + object id), before any email match.
 *
 * The fake answers the two lookups (migration <version>_idp_object_id_lookups.sql) as the
 * database does: rows of auth.identities (provider azure) carry tid and oid; both compare
 * lower(btrim()) on tid and oid; user_id_for_idp_object_id returns the single user with that
 * (tid, oid) and only when a users row exists, else NULL; idp_object_ids_for_users returns
 * one row per member with a match in the tenant. Fixture shape from handle_new_user
 * (3998 migration :303): oauth_id is the sign-in subject, a different GUID from the oid.
 *
 * index.ts is Deno source that calls Deno.serve at load: the Deno global is stubbed and the
 * jsr: modules are virtual. Provider users are injected, except in C14, which stubs fetch.
 */

jest.mock('jsr:@supabase/functions-js/edge-runtime.d.ts', () => ({}), { virtual: true });
jest.mock('jsr:@supabase/supabase-js@2', () => ({ createClient: jest.fn() }), { virtual: true });

(globalThis as unknown as { Deno: unknown }).Deno = { serve: jest.fn(), env: { get: () => undefined } };

type Row = Record<string, unknown>;
type Err = { code?: string; message: string } | null;
type Write = { table: string; op: 'insert' | 'update' | 'delete'; payload?: Row; filters: Row };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sync = require('../../supabase/functions/directory-sync/index') as {
  syncOrganization: (db: unknown, orgId: string, org: Row, idp: Row, opts?: Row) => Promise<Row>;
};

/** BACKLOG-4034: invented all-zero GUID placeholders (built, not literal). */
const fakeGuid = (tail: string) => `00000000-0000-0000-0000-${tail.padStart(12, '0')}`;
// All-zero-style placeholders: tenant, a second tenant, object ids, sign-in subjects.
const TID = fakeGuid('a1');
const TID_OTHER = fakeGuid('a2');
const OID_M = fakeGuid('b1');
const OID_Y = fakeGuid('b2');
const OID_NEW = fakeGuid('b9');
const SUB_M = fakeGuid('c1');
const SUB_Y = fakeGuid('c2');
const ORG = 'org-dir';

interface FakeOpts {
  failMemberMap?: boolean;
  failOidLookup?: boolean;
  /** Users ids the users read (index.ts members load) leaves out, as a failed read would. */
  hideUsers?: string[];
}

function makeDb(tables: Record<string, Row[]>, opts: FakeOpts = {}) {
  const writes: Write[] = [];
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  let seq = 0;
  function from(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Row | undefined;
    const filters: Row = {};
    const preds: Array<(r: Row) => boolean> = [];
    const run = (): { data: unknown; error: Err } => {
      const rows = (tables[table] ??= []);
      let hit = rows.filter((r) => preds.every((p) => p(r)));
      if (op === 'select') {
        if (table === 'users' && opts.hideUsers) hit = hit.filter((r) => !opts.hideUsers!.includes(String(r.id)));
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (op === 'insert') {
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
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  const inTenant = (t: unknown) => (tables.auth_identities ?? []).filter((i) => norm(i.tid) === norm(t));
  const rpc = async (fn: string, args: Row) => {
    rpcCalls.push({ fn, args });
    if (fn === 'user_id_for_auth_email') {
      return { data: (tables.auth_users ?? []).find((u) => u.email === args.p_email)?.id ?? null, error: null };
    }
    if (fn === 'idp_object_ids_for_users') {
      if (opts.failMemberMap) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      const ids = (args.p_user_ids as string[]) ?? [];
      const seen = new Set<string>();
      const out: Row[] = [];
      for (const i of inTenant(args.p_tenant_id)) {
        const uid = String(i.user_id);
        if (!ids.includes(uid) || seen.has(uid)) continue;
        seen.add(uid);
        out.push({ user_id: uid, object_id: norm(i.oid) });
      }
      return { data: out, error: null };
    }
    if (fn === 'user_id_for_idp_object_id') {
      if (opts.failOidLookup) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
      const hits = [...new Set(inTenant(args.p_tenant_id).filter((i) => norm(i.oid) === norm(args.p_object_id)).map((i) => String(i.user_id)))];
      const ok = hits.length === 1 && (tables.users ?? []).some((u) => u.id === hits[0]);
      return { data: ok ? hits[0] : null, error: null };
    }
    return { data: null, error: null };
  };
  return { client: { from, rpc }, writes, tables, rpcCalls };
}

const IDP = { id: 'idp-1', organization_id: ORG, provider_type: 'azure_ad', client_id: null, client_secret_encrypted: null,
  service_account_key_encrypted: null, issuer_url: null, is_active: true, attribute_mapping: null };
const ORG_ROW = { id: ORG, default_member_role: 'agent', microsoft_tenant_id: TID };
const person = (externalId: string, email: string) => ({ externalId, email, firstName: null, lastName: null, displayName: null, groups: [] });
const users = (list: Row[]) => async () => list.map((p) => ({ ...p }));

/** Member M: directory_sync, active; stored email differs from the directory email; oauth_id = sign-in subject. */
function memberFixture(extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    organization_members: [
      { organization_id: ORG, user_id: 'u-m', provisioned_by: 'directory_sync', license_status: 'active', group_sync_enabled: null, role: 'agent' },
    ],
    users: [{ id: 'u-m', email: 'm.old@example.test', oauth_id: SUB_M, scim_external_id: null }],
    auth_users: [{ id: 'u-m', email: 'm.old@example.test' }],
    auth_identities: [{ user_id: 'u-m', tid: TID, oid: OID_M }],
    organizations: [{ id: ORG, directory_sync_error: null }],
    ...extra,
  } as Record<string, Row[]>;
}

/** Non-member Y: signed in (auth user + azure identity), no membership; sign-in email differs from directory email. */
function nonMemberFixture(extra: { members?: Row[]; orgs?: Row[] } = {}): Record<string, Row[]> {
  return {
    organization_members: [...(extra.members ?? [])],
    users: [{ id: 'u-y', email: 'y.signin@example.test', oauth_id: SUB_Y, scim_external_id: null }],
    auth_users: [{ id: 'u-y', email: 'y.signin@example.test' }],
    auth_identities: [{ user_id: 'u-y', tid: TID, oid: OID_Y }],
    organizations: [{ id: ORG, directory_sync_error: null }, ...(extra.orgs ?? [])],
  } as Record<string, Row[]>;
}

const memberInserts = (w: Write[]) => w.filter((x) => x.table === 'organization_members' && x.op === 'insert');
const memberUpdates = (w: Write[], id: string) => w.filter((x) => x.table === 'organization_members' && x.op === 'update' && x.filters.user_id === id);
const userInserts = (w: Write[]) => w.filter((x) => x.table === 'users' && x.op === 'insert');
const userWritesFor = (w: Write[], id: string) => w.filter((x) => x.table === 'users' && x.op !== 'insert' && x.filters.id === id);
const calls = (db: { rpcCalls: Array<{ fn: string; args: Row }> }, fn: string) => db.rpcCalls.filter((c) => c.fn === fn);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('BACKLOG-4034 directory sync: members by object id', () => {
  it('C1 member found by object id although the stored email differs: matched, no add, no new users row', async () => {
    const t = memberFixture();
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_M, 'm.new@example.test')]) });
    expect(calls(db, 'idp_object_ids_for_users')).toHaveLength(1);
    expect(memberInserts(db.writes)).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(memberUpdates(db.writes, 'u-m')[0]?.payload).toHaveProperty('scim_synced_at');
    expect(t.organization_members[0].license_status).toBe('active');
    expect(r).toMatchObject({ added: 0, suspended: 0, error: null });
  });

  it('C2 oauth_id holds the account id (collision fallback): the member is still found by object id, not by the subject', async () => {
    const t = memberFixture({ users: [{ id: 'u-m', email: 'm.old@example.test', oauth_id: 'u-m', scim_external_id: null }] });
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_M, 'm.new@example.test')]) });
    expect(calls(db, 'idp_object_ids_for_users')).toHaveLength(1);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(memberUpdates(db.writes, 'u-m')).toHaveLength(1);
    expect(r).toMatchObject({ added: 0, suspended: 0, error: null });
  });

  it('C1b member found by object id but missing from the users read: marked seen, not added, not suspended', async () => {
    const t = memberFixture();
    const db = makeDb(t, { hideUsers: ['u-m'] });
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_M, 'm.new@example.test')]) });
    expect(calls(db, 'user_id_for_idp_object_id')).toHaveLength(1);
    expect(memberInserts(db.writes)).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(t.organization_members[0].license_status).toBe('active');
    expect(r).toMatchObject({ added: 0, suspended: 0, error: null });
  });

  it('C1c a mixed-case scim_external_id still matches the lower-case directory id', async () => {
    const t = memberFixture({
      users: [{ id: 'u-m', email: 'm.old@example.test', oauth_id: SUB_M, scim_external_id: OID_NEW.toUpperCase() }],
      auth_identities: [],
    });
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_NEW, 'm.new@example.test')]) });
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(memberUpdates(db.writes, 'u-m')).toHaveLength(1);
    expect(r).toMatchObject({ added: 0, suspended: 0, error: null });
  });

  it('C3 both lookups are asked with the organization tenant', async () => {
    const t = memberFixture({
      users: [
        { id: 'u-m', email: 'm.old@example.test', oauth_id: SUB_M, scim_external_id: null },
        { id: 'u-y', email: 'y.signin@example.test', oauth_id: SUB_Y, scim_external_id: null },
      ],
      auth_users: [{ id: 'u-m', email: 'm.old@example.test' }, { id: 'u-y', email: 'y.signin@example.test' }],
      auth_identities: [{ user_id: 'u-m', tid: TID, oid: OID_M }, { user_id: 'u-y', tid: TID, oid: OID_Y }],
    });
    const db = makeDb(t);
    await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, {
      fetchUsers: users([person(OID_M, 'm.new@example.test'), person(OID_Y, 'y.dir@example.test')]),
    });
    const map = calls(db, 'idp_object_ids_for_users');
    const one = calls(db, 'user_id_for_idp_object_id');
    expect(map).toHaveLength(1);
    expect(map[0].args).toEqual({ p_user_ids: ['u-m'], p_tenant_id: TID });
    expect(one).toEqual([{ fn: 'user_id_for_idp_object_id', args: { p_tenant_id: TID, p_object_id: OID_Y } }]);
  });

  it('C5 a matched member keeps oauth_id (the sign-in subject)', async () => {
    const t = memberFixture({ users: [{ id: 'u-m', email: 'm.new@example.test', oauth_id: SUB_M, scim_external_id: null }] });
    const db = makeDb(t);
    await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_M, 'm.new@example.test')]) });
    expect(t.users[0].oauth_id).toBe(SUB_M);
    expect(userWritesFor(db.writes, 'u-m').some((w) => 'oauth_id' in (w.payload ?? {}))).toBe(false);
  });

  it('C5b a placed non-member keeps oauth_id (the sign-in subject)', async () => {
    const t = nonMemberFixture();
    t.users[0].email = 'y.dir@example.test';
    t.auth_users[0].email = 'y.dir@example.test';
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_Y, 'y.dir@example.test')]) });
    expect(r).toMatchObject({ added: 1, error: null });
    expect(t.users[0].oauth_id).toBe(SUB_Y);
    expect(userWritesFor(db.writes, 'u-y').some((w) => 'oauth_id' in (w.payload ?? {}))).toBe(false);
  });
});

describe('BACKLOG-4034 directory sync: lookup errors stop the run', () => {
  it('C7 the member-map lookup fails: the run stops, nobody added, changed or suspended, error recorded', async () => {
    const t = memberFixture({
      organization_members: [
        { organization_id: ORG, user_id: 'u-m', provisioned_by: 'directory_sync', license_status: 'active', group_sync_enabled: null, role: 'agent' },
        { organization_id: ORG, user_id: 'u-dep', provisioned_by: 'directory_sync', license_status: 'active', group_sync_enabled: null, role: 'agent' },
      ],
      users: [
        { id: 'u-m', email: 'm.old@example.test', oauth_id: SUB_M, scim_external_id: null },
        { id: 'u-dep', email: 'dep@example.test', oauth_id: null, scim_external_id: null },
      ],
    });
    const db = makeDb(t, { failMemberMap: true });
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, {
      fetchUsers: users([person(OID_M, 'm.old@example.test'), person(OID_NEW, 'new@example.test')]),
    });
    expect(calls(db, 'idp_object_ids_for_users')).toHaveLength(1);
    expect(calls(db, 'user_id_for_auth_email')).toHaveLength(0);
    expect(memberInserts(db.writes)).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(db.writes.filter((w) => w.table === 'organization_members')).toHaveLength(0);
    expect(t.organization_members.every((m) => m.license_status === 'active')).toBe(true);
    expect(r.error).toEqual(expect.any(String));
    expect(t.organizations[0].directory_sync_error).toEqual(r.error);
  });

  it('C12b the per-person object-id lookup fails: the run stops; an email-only directory_sync member is not suspended', async () => {
    // E: active directory_sync member with no azure identity in the tenant (matched by email only).
    const t: Record<string, Row[]> = {
      organization_members: [
        { organization_id: ORG, user_id: 'u-e', provisioned_by: 'directory_sync', license_status: 'active', group_sync_enabled: null, role: 'agent' },
      ],
      users: [{ id: 'u-e', email: 'e@example.test', oauth_id: SUB_M, scim_external_id: null }],
      auth_users: [{ id: 'u-e', email: 'e@example.test' }],
      auth_identities: [],
      organizations: [{ id: ORG, directory_sync_error: null }],
    };
    const db = makeDb(t, { failOidLookup: true });
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_NEW, 'e@example.test')]) });
    expect(calls(db, 'user_id_for_idp_object_id')).toHaveLength(1);
    expect(t.organization_members[0].license_status).toBe('active');
    expect(db.writes.filter((w) => w.table === 'organization_members')).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(userWritesFor(db.writes, 'u-e')).toHaveLength(0);
    expect(r).toMatchObject({ added: 0, suspended: 0 });
    expect(r.error).toEqual(expect.any(String));
    expect(t.organizations[0].directory_sync_error).toEqual(r.error);
  });
});

describe('BACKLOG-4034 directory sync: precedence and non-members', () => {
  it('C9a the directory email belongs to member X, the object id to member Y: Y is matched, X untouched', async () => {
    const t: Record<string, Row[]> = {
      organization_members: [
        { organization_id: ORG, user_id: 'u-x', provisioned_by: 'manual', license_status: 'active', group_sync_enabled: null, role: 'agent' },
        { organization_id: ORG, user_id: 'u-y', provisioned_by: 'directory_sync', license_status: 'active', group_sync_enabled: null, role: 'agent' },
      ],
      users: [
        { id: 'u-x', email: 'shared@example.test', oauth_id: SUB_M, scim_external_id: null },
        { id: 'u-y', email: 'y.signin@example.test', oauth_id: SUB_Y, scim_external_id: null },
      ],
      auth_users: [{ id: 'u-x', email: 'shared@example.test' }, { id: 'u-y', email: 'y.signin@example.test' }],
      auth_identities: [{ user_id: 'u-y', tid: TID, oid: OID_Y }],
      organizations: [{ id: ORG, directory_sync_error: null }],
    };
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_Y, 'shared@example.test')]) });
    expect(memberUpdates(db.writes, 'u-y')).toHaveLength(1);
    expect(memberUpdates(db.writes, 'u-x')).toHaveLength(0);
    expect(userWritesFor(db.writes, 'u-x')).toHaveLength(0);
    expect(r).toMatchObject({ added: 0, suspended: 0, error: null });
  });

  it('C9b the directory email belongs to member X, the object id to non-member Y: Y is added, X untouched', async () => {
    const t: Record<string, Row[]> = {
      organization_members: [
        { organization_id: ORG, user_id: 'u-x', provisioned_by: 'manual', license_status: 'active', group_sync_enabled: null, role: 'agent' },
      ],
      users: [
        { id: 'u-x', email: 'shared@example.test', oauth_id: SUB_M, scim_external_id: null },
        { id: 'u-y', email: 'y.signin@example.test', oauth_id: SUB_Y, scim_external_id: null },
      ],
      auth_users: [{ id: 'u-x', email: 'shared@example.test' }, { id: 'u-y', email: 'y.signin@example.test' }],
      auth_identities: [{ user_id: 'u-y', tid: TID, oid: OID_Y }],
      organizations: [{ id: ORG, directory_sync_error: null }],
    };
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_Y, 'shared@example.test')]) });
    expect(memberInserts(db.writes).map((w) => w.payload?.user_id)).toEqual(['u-y']);
    expect(memberUpdates(db.writes, 'u-x')).toHaveLength(0);
    expect(userWritesFor(db.writes, 'u-x')).toHaveLength(0);
    expect(r).toMatchObject({ added: 1, error: null });
  });

  it('C10 non-member found by object id: added as that account, no new users row, no email lookup', async () => {
    const t = nonMemberFixture();
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_Y, 'y.dir@example.test')]) });
    expect(calls(db, 'user_id_for_idp_object_id')).toHaveLength(1);
    expect(calls(db, 'user_id_for_auth_email')).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(memberInserts(db.writes).map((w) => w.payload?.user_id)).toEqual(['u-y']);
    expect(r).toMatchObject({ added: 1, error: null });
  });

  it('C10 guard: found by object id but in another brokerage -> not added (already_placed)', async () => {
    const t = nonMemberFixture({
      members: [{ organization_id: 'org-b', user_id: 'u-y', provisioned_by: 'manual', license_status: 'active' }],
      orgs: [{ id: 'org-b', personal_owner_user_id: null }],
    });
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_Y, 'y.dir@example.test')]) });
    expect(calls(db, 'user_id_for_idp_object_id')).toHaveLength(1);
    expect(memberInserts(db.writes)).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(r).toMatchObject({ added: 0, error: null });
  });

  it('C10 guard: found by object id, only a personal account -> not added (personal_account)', async () => {
    const t = nonMemberFixture({
      members: [{ organization_id: 'org-p', user_id: 'u-y', provisioned_by: 'manual', license_status: 'active' }],
      orgs: [{ id: 'org-p', personal_owner_user_id: 'u-y' }],
    });
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, { fetchUsers: users([person(OID_Y, 'y.dir@example.test')]) });
    expect(calls(db, 'user_id_for_idp_object_id')).toHaveLength(1);
    expect(memberInserts(db.writes)).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(r).toMatchObject({ added: 0, error: null });
  });

  it('C13 billing setup pending: a non-member found by object id is counted as waiting, nothing written', async () => {
    const t = nonMemberFixture();
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, ORG_ROW, IDP, {
      joinsBlocked: true,
      fetchUsers: users([person(OID_Y, 'y.dir@example.test')]),
    });
    expect(calls(db, 'user_id_for_idp_object_id')).toHaveLength(1);
    expect(r).toMatchObject({ added: 0, skipped_billing_setup: 1, error: null });
    expect(memberInserts(db.writes)).toHaveLength(0);
    expect(userInserts(db.writes)).toHaveLength(0);
    expect(userWritesFor(db.writes, 'u-y')).toHaveLength(0);
  });

  it('C3b a different tenant on the organization never matches the person (no cross-tenant hit)', async () => {
    const t = nonMemberFixture();
    const db = makeDb(t);
    const r = await sync.syncOrganization(db.client, ORG, { ...ORG_ROW, microsoft_tenant_id: TID_OTHER }, IDP, {
      fetchUsers: users([person(OID_Y, 'y.dir@example.test')]),
    });
    expect(calls(db, 'user_id_for_idp_object_id')[0]?.args).toEqual({ p_tenant_id: TID_OTHER, p_object_id: OID_Y });
    expect(memberInserts(db.writes).some((w) => w.payload?.user_id === 'u-y')).toBe(false);
    expect(r).toMatchObject({ error: null });
  });
});

describe('BACKLOG-4034 directory sync: domain-form tenant', () => {
  it('C14 a domain-form tenant still gets the Graph token with the raw value; email path, no object-id lookup, no throw', async () => {
    const DOMAIN_TENANT = 'example-test.onmicrosoft.com';
    const urls: string[] = [];
    const fetchMock = jest.fn(async (url: unknown) => {
      const u = String(url);
      urls.push(u);
      if (u.startsWith('https://login.microsoftonline.com/')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: [{ id: OID_NEW, mail: 'new@example.test' }] }), { status: 200 });
    });
    const realFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
    try {
      const t = nonMemberFixture();
      const db = makeDb(t);
      const r = await sync.syncOrganization(db.client, ORG, { ...ORG_ROW, microsoft_tenant_id: DOMAIN_TENANT },
        { ...IDP, client_id: 'client-1', client_secret_encrypted: 'not-a-secret' });
      expect(r.error).toBeNull();
      expect(urls[0]).toContain(`/${DOMAIN_TENANT}/`);
      expect(calls(db, 'idp_object_ids_for_users')).toHaveLength(0);
      expect(calls(db, 'user_id_for_idp_object_id')).toHaveLength(0);
      expect(calls(db, 'user_id_for_auth_email')).toHaveLength(1);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
    }
  });
});
