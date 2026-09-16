/**
 * middleware.ts and a personal organization — BACKLOG-3364.
 *
 * ---------------------------------------------------------------------------
 * What this file is defending.
 * ---------------------------------------------------------------------------
 * Two failures, in opposite directions, and each one looks fine from the other
 * side:
 *
 *   1. The personal row counted as a placement. A solo user holds a membership
 *      with role `agent`, so `/dashboard/*` bounces them to `/download` where
 *      before they were admitted. Everything about a brokerage still works, so
 *      no brokerage test notices.
 *
 *   2. The query naming `organizations.personal_owner_user_id` while production
 *      has not had the migration applied. PostgREST answers 400 / 42703 with
 *      `data: null` and does not throw, so `membership` reads null and EVERY
 *      brokerage member is admitted to `/dashboard` regardless of role — the
 *      bounce silently stops working for everyone. Every personal-org test
 *      still passes, because a solo user is admitted either way.
 *
 * The suite runs the REAL middleware against a stub that answers 42703 the way
 * the database does, sourced from the responses PR 1 captured from a real
 * PostgREST (supabase/tests/backlog-3364/fixtures/).
 *
 * @jest-environment node
 */

import {
  ABSENT_COLUMN_ERROR,
  BROKERAGE_ORG_PRE,
  FIXTURE_USER_ID,
  PERSONAL_COLUMN,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  type Row,
} from './helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockEmulator.from(table),
  })),
}));

import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';

const ORIGIN = 'http://localhost:3000';

function signedIn(): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
}

/** Where middleware sends this request, or null when it admits it. */
async function verdict(path = '/dashboard'): Promise<string | null> {
  const response = await middleware(new NextRequest(`${ORIGIN}${path}`));
  return response.headers.get('location');
}

function given(rows: Row[], columnPresent = true): void {
  signedIn();
  mockEmulator.set({ columnPresent, rows: { organization_members: rows } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
});

// ---------------------------------------------------------------------------
// 0. The control on the controls. If this describe is wrong, nothing below
//    means anything — a stub that cannot produce 42703 makes every "the reader
//    survives a database without the column" test vacuous.
// ---------------------------------------------------------------------------

describe('the stub reproduces a database without the column', () => {
  it('answers 42703 — no throw — whenever a query names it, exactly as production did', async () => {
    mockEmulator.set({ columnPresent: false, rows: { organization_members: [] } });

    const bySelect = await mockEmulator
      .from('organization_members')
      .select(`organization_id, organizations(name, ${PERSONAL_COLUMN})`);
    const byOrder = await mockEmulator
      .from('organization_members')
      .select('organization_id, organizations(*)')
      .order(PERSONAL_COLUMN, { referencedTable: 'organizations' });
    const byFilter = await mockEmulator
      .from('organization_members')
      .select('organization_id, organizations(*)')
      .is(`organizations.${PERSONAL_COLUMN}`, null);

    for (const result of [bySelect, byOrder, byFilter]) {
      expect(result.status).toBe(400);
      expect(result.data).toBeNull();
      expect(result.error).toEqual(ABSENT_COLUMN_ERROR);
    }

    // The error text is the database's, not this file's invention.
    expect(ABSENT_COLUMN_ERROR.code).toBe('42703');
    expect(ABSENT_COLUMN_ERROR.message).toContain(PERSONAL_COLUMN);
  });

  it('answers 200 for the shape the portal actually sends (case B)', async () => {
    mockEmulator.set({
      columnPresent: false,
      rows: { organization_members: [brokerageMembership('broker', 'pre')] },
    });

    const result = await mockEmulator
      .from('organization_members')
      .select('role, organization_id, organizations(*)')
      .eq('user_id', FIXTURE_USER_ID);

    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect((result.data as Row[])).toHaveLength(1);
  });

  it('serves a pre-migration organization record that simply has no such key', () => {
    expect(PERSONAL_COLUMN in BROKERAGE_ORG_PRE).toBe(false);
    expect(Object.keys(BROKERAGE_ORG_PRE)).toContain('jit_provisioning_enabled');
  });
});

// ---------------------------------------------------------------------------
// 1. A database WITHOUT the column. This is production until the founder
//    applies migration 1, and every deploying branch reads production.
// ---------------------------------------------------------------------------

describe('against a database that has not had the migration applied', () => {
  it('still admits a brokerage broker to /dashboard', async () => {
    given([brokerageMembership('broker', 'pre')], false);
    expect(await verdict()).toBeNull();
  });

  it('still bounces a brokerage agent to /download', async () => {
    given([brokerageMembership('agent', 'pre')], false);
    expect(await verdict()).toBe(`${ORIGIN}/download`);
  });

  it('never names the column in the query it sends', async () => {
    given([brokerageMembership('agent', 'pre')], false);
    await verdict();

    const selects = mockEmulator.state.selects.filter(
      (s) => s.table === 'organization_members'
    );
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s.columns).not.toContain(PERSONAL_COLUMN);
  });
});

// ---------------------------------------------------------------------------
// 2. A database WITH the column — personal organizations exist.
// ---------------------------------------------------------------------------

describe('a solo user holding only a personal organization', () => {
  it('is admitted to /dashboard, exactly as a user with no membership row is', async () => {
    given([personalMembership()]);
    const withPersonalRow = await verdict();

    given([]);
    const withNoRowAtAll = await verdict();

    expect(withPersonalRow).toBeNull();
    expect(withPersonalRow).toBe(withNoRowAtAll);
  });

  it('is admitted on every protected path, not just the dashboard root', async () => {
    for (const path of ['/dashboard', '/dashboard/account', '/dashboard/settings']) {
      given([personalMembership()]);
      expect(await verdict(path)).toBeNull();
    }
  });
});

describe('brokerage membership still decides the route', () => {
  it('bounces a brokerage agent to /download', async () => {
    given([brokerageMembership('agent')]);
    expect(await verdict()).toBe(`${ORIGIN}/download`);
  });

  it.each(['broker', 'admin', 'it_admin'])('admits a brokerage %s', async (role) => {
    given([brokerageMembership(role)]);
    expect(await verdict()).toBeNull();
  });

  it('takes the brokerage row when a personal row is returned first', async () => {
    // The retirement trigger removes the personal row when a brokerage
    // membership is written, so this pairing should not outlive a transaction —
    // but "should not exist" is not a routing rule. A broker whose personal row
    // sorted first must not be bounced to /download.
    given([personalMembership(), brokerageMembership('broker')]);
    expect(await verdict()).toBeNull();
  });

  it('still bounces when the only brokerage row is an agent and a personal row sorts first', async () => {
    given([personalMembership(), brokerageMembership('agent')]);
    expect(await verdict()).toBe(`${ORIGIN}/download`);
  });

  it('resolves two brokerage rows in the order the query returned them, not arbitrarily', async () => {
    // SCIM and directory sync can each write a membership, so two brokerage
    // rows are reachable. `.limit(1).single()` used to make this an error
    // result — read as "no membership" — which admitted the user whatever their
    // roles were.
    const first = brokerageMembership('agent');
    const second = { ...brokerageMembership('broker'), id: 'second-row' };
    given([first, second]);
    expect(await verdict()).toBe(`${ORIGIN}/download`);

    given([second, first]);
    expect(await verdict()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The pre-existing behaviour this change must not disturb.
// ---------------------------------------------------------------------------

describe('unchanged behaviour', () => {
  it('sends an unauthenticated visitor on a protected route to /login with redirectTo', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const response = await middleware(new NextRequest(`${ORIGIN}/dashboard/account`));
    const location = response.headers.get('location');
    expect(location).toContain('/login');
    expect(location).toContain('redirectTo=%2Fdashboard%2Faccount');
  });

  it('redirects a crashed session to /login — so toBeNull() above means admitted', async () => {
    mockGetUser.mockRejectedValue(new Error('fixture: session lookup failed'));
    expect(await verdict()).toBe(`${ORIGIN}/login`);
  });

  it('does not query memberships at all for a public route', async () => {
    given([brokerageMembership('agent')]);
    await middleware(new NextRequest(`${ORIGIN}/download`));
    expect(mockEmulator.state.selects).toHaveLength(0);
  });
});
