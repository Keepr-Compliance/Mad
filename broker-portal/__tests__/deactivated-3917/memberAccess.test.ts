/**
 * requireActiveOrgRole — BACKLOG-3917 (SR R7).
 *
 * Row shapes are what PostgREST returns for the two selects the helper sends:
 * organization_members 'role, license_status' (maybeSingle) and licenses
 * 'status' (maybeSingle). Error shape: PostgREST's { code, message } with
 * data null.
 *
 * @jest-environment node
 */

import { MEMBERSHIP_READ_FAILED, requireActiveOrgRole } from '@/lib/auth/memberAccess';
import { LICENCE_READ_FAILED } from '@/lib/auth/suspension';

type Result = { data: unknown; error: unknown };
interface Call {
  table: string;
  ops: [string, ...unknown[]][];
}

function client(results: Record<string, Result | (() => Promise<Result>)>) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) {
        b[m] = (...a: unknown[]) => {
          call.ops.push([m, ...a]);
          return b;
        };
      }
      b.maybeSingle = () => {
        const r = results[table] ?? { data: null, error: null };
        return typeof r === 'function' ? r() : Promise.resolve(r);
      };
      return b;
    },
  };
}

const USER = 'user-3917';
const ORG = 'org-3917';
const ADMIN_ROLES = ['admin', 'it_admin'];
const MEMBER = (role: string, license_status: unknown) => ({ data: { role, license_status }, error: null });
const LICENCE = (status: string) => ({ data: { status }, error: null });
const ERR = { data: null, error: { code: 'XX000', message: 'boom' } };

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const run = (c: ReturnType<typeof client>, roles = ADMIN_ROLES) =>
  requireActiveOrgRole(c as never, USER, ORG, roles);

it('admits an active admin with an active licence', async () => {
  await expect(run(client({ organization_members: MEMBER('admin', 'active'), licenses: LICENCE('active') }))).resolves.toEqual({
    ok: true,
    role: 'admin',
  });
});

it('admits an active admin with no licence row (the licence read returns null data)', async () => {
  await expect(run(client({ organization_members: MEMBER('admin', 'active') }))).resolves.toEqual({ ok: true, role: 'admin' });
});

it('reads the caller row in the TARGET organization', async () => {
  const c = client({ organization_members: MEMBER('admin', 'active') });
  await run(c);
  const m = c.calls.find((x) => x.table === 'organization_members')!;
  expect(m.ops).toEqual(
    expect.arrayContaining([
      ['select', 'role, license_status'],
      ['eq', 'user_id', USER],
      ['eq', 'organization_id', ORG],
    ])
  );
});

it.each(['suspended', 'expired', 'pending', null])('refuses a %p membership', async (status) => {
  await expect(run(client({ organization_members: MEMBER('admin', status) }))).resolves.toEqual({
    ok: false,
    reason: 'refused',
  });
});

it('refuses with reason role when an active row has the wrong role', async () => {
  await expect(run(client({ organization_members: MEMBER('agent', 'active') }))).resolves.toEqual({ ok: false, reason: 'role' });
});

it('a deactivated agent gets refused, not role (status is checked first)', async () => {
  await expect(run(client({ organization_members: MEMBER('agent', 'suspended') }))).resolves.toEqual({
    ok: false,
    reason: 'refused',
  });
});

it('refuses no row', async () => {
  await expect(run(client({}))).resolves.toEqual({ ok: false, reason: 'refused' });
});

it('refuses a suspended licence on an active admin', async () => {
  await expect(run(client({ organization_members: MEMBER('admin', 'active'), licenses: LICENCE('suspended') }))).resolves.toEqual({
    ok: false,
    reason: 'refused',
  });
});

it('refuses on a licence read error and logs the static code only', async () => {
  await expect(run(client({ organization_members: MEMBER('admin', 'active'), licenses: ERR }))).resolves.toEqual({
    ok: false,
    reason: 'refused',
  });
  expect(warn).toHaveBeenCalledWith(expect.any(String), { code: LICENCE_READ_FAILED });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('boom');
});

it('refuses on a membership read error and logs the static code only', async () => {
  await expect(run(client({ organization_members: ERR, licenses: LICENCE('active') }))).resolves.toEqual({
    ok: false,
    reason: 'refused',
  });
  expect(warn).toHaveBeenCalledWith(expect.any(String), { code: MEMBERSHIP_READ_FAILED });
  expect(JSON.stringify(warn.mock.calls)).not.toContain('boom');
});

it('reads membership and licence together, not one after the other', async () => {
  let release!: (r: Result) => void;
  const held = new Promise<Result>((r) => (release = r));
  const c = client({ organization_members: () => held, licenses: LICENCE('active') });
  const pending = run(c);
  await Promise.resolve();
  expect(c.calls.map((x) => x.table)).toEqual(['organization_members', 'licenses']);
  release(MEMBER('admin', 'active'));
  await expect(pending).resolves.toEqual({ ok: true, role: 'admin' });
});

it('refuses an empty organization id without reading', async () => {
  const c = client({ organization_members: MEMBER('admin', 'active') });
  await expect(requireActiveOrgRole(c as never, USER, '', ADMIN_ROLES)).resolves.toEqual({ ok: false, reason: 'refused' });
  expect(c.calls).toHaveLength(0);
});
