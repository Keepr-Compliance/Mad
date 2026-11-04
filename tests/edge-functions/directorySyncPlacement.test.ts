/**
 * @jest-environment node
 *
 * BACKLOG-3998: directory sync finds an existing person by sign-in email
 * (user_id_for_auth_email) and applies the SCIM placement rules before adding them.
 * The client is a fake that answers the three reads placeDirectoryUser makes; the RPC
 * result is what the migration's function returns (a uuid string or null).
 */
import { placeDirectoryUser } from '../../supabase/functions/directory-sync/placement';

type Row = Record<string, unknown>;

function db(opts: {
  found: string | null;
  lookupError?: boolean;
  members?: Row[];
  orgs?: Row[];
  memberError?: boolean;
}) {
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const client = {
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      return opts.lookupError ? { data: null, error: { message: 'boom' } } : { data: opts.found, error: null };
    },
    from: (table: string) => ({
      select: () => ({
        eq: async (_c: string, v: unknown) =>
          opts.memberError
            ? { data: null, error: { message: 'boom' } }
            : { data: (opts.members ?? []).filter((m) => m.user_id === v), error: null },
        in: async (_c: string, ids: unknown[]) => ({
          data: table === 'organizations' ? (opts.orgs ?? []).filter((o) => ids.includes(o.id)) : [],
          error: null,
        }),
      }),
    }),
  };
  return { client, rpcCalls };
}

const ORG = 'org-1';

describe('placeDirectoryUser (BACKLOG-3998)', () => {
  it('asks user_id_for_auth_email with the directory email; no match -> new', async () => {
    const d = db({ found: null });
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({ kind: 'new' });
    expect(d.rpcCalls).toEqual([{ fn: 'user_id_for_auth_email', args: { p_email: 'p@example.test' } }]);
  });

  it('a person with no other membership is added', async () => {
    const d = db({ found: 'u-1', members: [] });
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({ kind: 'add', userId: 'u-1', matchedBy: 'email' });
  });

  it('a person in another brokerage is skipped (already_placed)', async () => {
    const d = db({
      found: 'u-1',
      members: [{ user_id: 'u-1', organization_id: 'org-b' }],
      orgs: [{ id: 'org-b', personal_owner_user_id: null }],
    });
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({
      kind: 'skip', userId: 'u-1', reason: 'already_placed', matchedBy: 'email',
    });
  });

  it('a person whose only membership is their personal account is skipped (personal_account)', async () => {
    const d = db({
      found: 'u-1',
      members: [{ user_id: 'u-1', organization_id: 'org-p' }],
      orgs: [{ id: 'org-p', personal_owner_user_id: 'u-1' }],
    });
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({
      kind: 'skip', userId: 'u-1', reason: 'personal_account', matchedBy: 'email',
    });
  });

  it('personal account plus another brokerage is already_placed', async () => {
    const d = db({
      found: 'u-1',
      members: [{ user_id: 'u-1', organization_id: 'org-p' }, { user_id: 'u-1', organization_id: 'org-b' }],
      orgs: [{ id: 'org-p', personal_owner_user_id: 'u-1' }, { id: 'org-b', personal_owner_user_id: null }],
    });
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toMatchObject({ reason: 'already_placed' });
  });

  it('a membership in this organization only is not "another brokerage"', async () => {
    const d = db({ found: 'u-1', members: [{ user_id: 'u-1', organization_id: ORG }] });
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({ kind: 'add', userId: 'u-1', matchedBy: 'email' });
  });

  it('read failures skip the person instead of adding them', async () => {
    await expect(placeDirectoryUser(db({ found: null, lookupError: true }).client, ORG, 'p@example.test'))
      .resolves.toMatchObject({ kind: 'skip', reason: 'lookup_failed' });
    await expect(placeDirectoryUser(db({ found: 'u-1', memberError: true }).client, ORG, 'p@example.test'))
      .resolves.toMatchObject({ kind: 'skip', reason: 'lookup_failed' });
    const missingOrg = db({ found: 'u-1', members: [{ user_id: 'u-1', organization_id: 'org-gone' }], orgs: [] });
    await expect(placeDirectoryUser(missingOrg.client, ORG, 'p@example.test'))
      .resolves.toMatchObject({ kind: 'skip', reason: 'lookup_failed' });
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-4034: the object-id step (tenant + object id) runs before the email lookup.
// ---------------------------------------------------------------------------

function oidDb(opts: { oidFound: string | null; oidError?: boolean; emailFound?: string | null; members?: Row[]; orgs?: Row[] }) {
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  const client = {
    rpc: async (fn: string, args: Row) => {
      rpcCalls.push({ fn, args });
      if (fn === 'user_id_for_idp_object_id') {
        return opts.oidError ? { data: null, error: { message: 'boom' } } : { data: opts.oidFound, error: null };
      }
      return { data: opts.emailFound ?? null, error: null };
    },
    from: (table: string) => ({
      select: () => ({
        eq: async (_c: string, v: unknown) => ({ data: (opts.members ?? []).filter((m) => m.user_id === v), error: null }),
        in: async (_c: string, ids: unknown[]) => ({
          data: table === 'organizations' ? (opts.orgs ?? []).filter((o) => ids.includes(o.id)) : [],
          error: null,
        }),
      }),
    }),
  };
  return { client, rpcCalls };
}

/** BACKLOG-4034: invented all-zero GUID placeholders (built, not literal). */
const fakeGuid = (tail: string) => `00000000-0000-0000-0000-${tail.padStart(12, '0')}`;
const TENANT = fakeGuid('a1');
const OBJ = fakeGuid('b1');
const KEY = { tenantId: TENANT, objectId: OBJ };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const place = placeDirectoryUser as any;

describe('placeDirectoryUser object-id step (BACKLOG-4034)', () => {
  it('C12 the object-id lookup fails: skip lookup_failed, the email lookup is never asked', async () => {
    const d = oidDb({ oidFound: null, oidError: true, emailFound: 'u-email' });
    await expect(place(d.client, ORG, 'p@example.test', KEY, { objectIdOnly: true }))
      .resolves.toMatchObject({ kind: 'skip', userId: null, reason: 'lookup_failed' });
    await expect(place(d.client, ORG, 'p@example.test', KEY))
      .resolves.toMatchObject({ kind: 'skip', userId: null, reason: 'lookup_failed' });
    expect(d.rpcCalls.map((c) => c.fn)).toEqual(['user_id_for_idp_object_id', 'user_id_for_idp_object_id']);
  });

  it('C10 a hit is added as that account with matchedBy object_id; the email lookup is not asked', async () => {
    const d = oidDb({ oidFound: 'u-oid', emailFound: 'u-email' });
    await expect(place(d.client, ORG, 'p@example.test', KEY, { objectIdOnly: true }))
      .resolves.toMatchObject({ kind: 'add', userId: 'u-oid', matchedBy: 'object_id' });
    expect(d.rpcCalls).toEqual([{ fn: 'user_id_for_idp_object_id', args: { p_tenant_id: TENANT, p_object_id: OBJ } }]);
  });

  it('C10 guards: a hit in another brokerage is already_placed; a hit with only a personal account is personal_account', async () => {
    const placed = oidDb({
      oidFound: 'u-oid',
      members: [{ user_id: 'u-oid', organization_id: 'org-b' }],
      orgs: [{ id: 'org-b', personal_owner_user_id: null }],
    });
    await expect(place(placed.client, ORG, 'p@example.test', KEY, { objectIdOnly: true }))
      .resolves.toMatchObject({ kind: 'skip', userId: 'u-oid', reason: 'already_placed' });
    const personal = oidDb({
      oidFound: 'u-oid',
      members: [{ user_id: 'u-oid', organization_id: 'org-p' }],
      orgs: [{ id: 'org-p', personal_owner_user_id: 'u-oid' }],
    });
    await expect(place(personal.client, ORG, 'p@example.test', KEY, { objectIdOnly: true }))
      .resolves.toMatchObject({ kind: 'skip', userId: 'u-oid', reason: 'personal_account' });
  });

  it('a hit already in this organization is member (never add, whose membership write would collide)', async () => {
    const d = oidDb({ oidFound: 'u-oid', members: [{ user_id: 'u-oid', organization_id: ORG }] });
    await expect(place(d.client, ORG, 'p@example.test', KEY, { objectIdOnly: true }))
      .resolves.toMatchObject({ kind: 'member', userId: 'u-oid' });
  });

  it('no hit: objectIdOnly answers none; without it the email lookup runs as today (matchedBy email)', async () => {
    const only = oidDb({ oidFound: null, emailFound: 'u-email' });
    await expect(place(only.client, ORG, 'p@example.test', KEY, { objectIdOnly: true })).resolves.toEqual({ kind: 'none' });
    expect(only.rpcCalls.map((c) => c.fn)).toEqual(['user_id_for_idp_object_id']);
    const both = oidDb({ oidFound: null, emailFound: 'u-email' });
    await expect(place(both.client, ORG, 'p@example.test', KEY))
      .resolves.toMatchObject({ kind: 'add', userId: 'u-email', matchedBy: 'email' });
    expect(both.rpcCalls.map((c) => c.fn)).toEqual(['user_id_for_idp_object_id', 'user_id_for_auth_email']);
  });
});
