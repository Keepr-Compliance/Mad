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
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({ kind: 'add', userId: 'u-1' });
  });

  it('a person in another brokerage is skipped (already_placed)', async () => {
    const d = db({
      found: 'u-1',
      members: [{ user_id: 'u-1', organization_id: 'org-b' }],
      orgs: [{ id: 'org-b', personal_owner_user_id: null }],
    });
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({
      kind: 'skip', userId: 'u-1', reason: 'already_placed',
    });
  });

  it('a person whose only membership is their personal account is skipped (personal_account)', async () => {
    const d = db({
      found: 'u-1',
      members: [{ user_id: 'u-1', organization_id: 'org-p' }],
      orgs: [{ id: 'org-p', personal_owner_user_id: 'u-1' }],
    });
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({
      kind: 'skip', userId: 'u-1', reason: 'personal_account',
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
    await expect(placeDirectoryUser(d.client, ORG, 'p@example.test')).resolves.toEqual({ kind: 'add', userId: 'u-1' });
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
