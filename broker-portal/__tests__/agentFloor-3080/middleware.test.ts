/**
 * middleware.ts and the portal floor — BACKLOG-3080 (C-mw).
 *
 * The REAL middleware runs against the PostgREST emulator. Every persona is
 * swept across every dashboard path, including the prefix boundary, and the
 * whole verdict table is asserted exactly.
 *
 * middleware is NOT the only gate: the layout and each page ask again
 * (route-audit.test.tsx invokes the pages directly, with middleware bypassed).
 *
 * @jest-environment node
 */

import {
  ABSENT_COLUMN_ERROR,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
  personalMembershipOwnedBy,
  type Row,
} from '../helpers/postgrestEmulator';

const mockEmulator = createPostgrestEmulator();
const mockGetUser = jest.fn();
let mockReadFails = false;

/**
 * A failed membership read: the chain still records its select and orders,
 * then resolves the transcribed PostgREST error shape with `data: null`.
 */
function mockFrom(table: string) {
  const chain = mockEmulator.from(table);
  if (mockReadFails && table === 'organization_members') {
    (chain as { then: unknown }).then = (
      onFulfilled: (r: unknown) => unknown,
      onRejected?: (e: unknown) => unknown
    ) =>
      Promise.resolve({ data: null, error: { ...ABSENT_COLUMN_ERROR }, status: 400 }).then(
        onFulfilled,
        onRejected
      );
  }
  return chain;
}

jest.mock('@supabase/ssr', () => ({
  createServerClient: jest.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => mockFrom(table),
  })),
}));

import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';

const ORIGIN = 'http://localhost:3000';
const ADMIT = null;
const TO_DASHBOARD = `${ORIGIN}/dashboard`;
const TO_LOGOUT = `${ORIGIN}/auth/logout?error=not_authorized`;

/** Where middleware sends this request, or null when it admits it. */
async function verdict(path: string): Promise<string | null> {
  const response = await middleware(new NextRequest(`${ORIGIN}${path}`));
  return response.headers.get('location');
}

function given(rows: Row[], options: { readFails?: boolean; columnPresent?: boolean } = {}): void {
  mockGetUser.mockResolvedValue({ data: { user: { id: FIXTURE_USER_ID } } });
  mockReadFails = options.readFails ?? false;
  mockEmulator.set({
    columnPresent: options.columnPresent ?? true,
    rows: { organization_members: rows },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmulator.reset();
  mockReadFails = false;
});

const PATHS = [
  '/dashboard',
  '/dashboard/account',
  '/dashboard/support',
  '/dashboard/support/abc-123',
  '/dashboard/submissions',
  '/dashboard/submissions/abc-123',
  '/dashboard/users',
  '/dashboard/users/abc-123',
  '/dashboard/settings',
  '/dashboard/settings/scim',
  '/dashboard/checklists',
  '/dashboard/checklists/new',
  '/dashboard/my-transactions',
  '/dashboard/my-transactions/abc-123',
  '/dashboard/my-transactionsx',
  '/dashboard/supportx',
  '/dashboard/accounts',
] as const;

type Verdict = typeof ADMIT | string;

const FLOOR_VERDICTS: Record<(typeof PATHS)[number], Verdict> = {
  '/dashboard': ADMIT,
  '/dashboard/account': ADMIT,
  '/dashboard/support': ADMIT,
  '/dashboard/support/abc-123': ADMIT,
  '/dashboard/submissions': TO_DASHBOARD,
  '/dashboard/submissions/abc-123': TO_DASHBOARD,
  '/dashboard/users': TO_DASHBOARD,
  '/dashboard/users/abc-123': TO_DASHBOARD,
  '/dashboard/settings': TO_DASHBOARD,
  '/dashboard/settings/scim': TO_DASHBOARD,
  // D4: checklists pass to their own page gate.
  '/dashboard/checklists': ADMIT,
  '/dashboard/checklists/new': ADMIT,
  // BACKLOG-3080: My Transactions is for a floor user routed on a BROKERAGE row
  // only; see BROKERAGE_FLOOR_VERDICTS. Everyone else on the floor goes back.
  '/dashboard/my-transactions': TO_DASHBOARD,
  '/dashboard/my-transactions/abc-123': TO_DASHBOARD,
  '/dashboard/my-transactionsx': TO_DASHBOARD,
  // Boundary: shared prefix, not a sub-path.
  '/dashboard/supportx': TO_DASHBOARD,
  '/dashboard/accounts': TO_DASHBOARD,
};

/** A floor user routed on a brokerage row: the floor, plus My Transactions (the page decides the plan). */
const BROKERAGE_FLOOR_VERDICTS: Record<(typeof PATHS)[number], Verdict> = {
  ...FLOOR_VERDICTS,
  '/dashboard/my-transactions': ADMIT,
  '/dashboard/my-transactions/abc-123': ADMIT,
};

const everywhere = (v: Verdict) =>
  Object.fromEntries(PATHS.map((p) => [p, v])) as Record<(typeof PATHS)[number], Verdict>;

const second = (row: Row): Row => ({ ...row, id: `${row.id as string}-second` });

const PERSONAS: [string, () => void, Record<(typeof PATHS)[number], Verdict>][] = [
  ['no membership', () => given([]), everywhere(TO_LOGOUT)],
  [
    'member of a personal org somebody else owns',
    () => given([personalMembershipOwnedBy()]),
    everywhere(TO_LOGOUT),
  ],
  ['membership read failed (broker rows)', () => given([brokerageMembership('broker')], { readFails: true }), FLOOR_VERDICTS],
  ['brokerage agent', () => given([brokerageMembership('agent')]), BROKERAGE_FLOOR_VERDICTS],
  ['brokerage agent, pre-migration', () => given([brokerageMembership('agent', 'pre')], { columnPresent: false }), BROKERAGE_FLOOR_VERDICTS],
  ['unrecognised brokerage role', () => given([brokerageMembership('viewer')]), BROKERAGE_FLOOR_VERDICTS],
  ['personal-org owner', () => given([personalMembership()]), FLOOR_VERDICTS],
  ['personal row then brokerage agent', () => given([personalMembership(), brokerageMembership('agent')]), BROKERAGE_FLOOR_VERDICTS],
  [
    'two brokerage rows [agent, broker]',
    () => given([brokerageMembership('agent'), second(brokerageMembership('broker'))]),
    BROKERAGE_FLOOR_VERDICTS,
  ],
  [
    'two brokerage rows [broker, agent]',
    () => given([brokerageMembership('broker'), second(brokerageMembership('agent'))]),
    everywhere(ADMIT),
  ],
  ['brokerage broker', () => given([brokerageMembership('broker')]), everywhere(ADMIT)],
  ['brokerage broker, pre-migration', () => given([brokerageMembership('broker', 'pre')], { columnPresent: false }), everywhere(ADMIT)],
  ['brokerage admin', () => given([brokerageMembership('admin')]), everywhere(ADMIT)],
  ['brokerage it_admin', () => given([brokerageMembership('it_admin')]), everywhere(ADMIT)],
];

describe('middleware verdict table', () => {
  it.each(PERSONAS)('%s', async (_name, arrange, expected) => {
    const actual: Record<string, Verdict> = {};
    for (const path of PATHS) {
      arrange();
      actual[path] = await verdict(path);
    }
    expect(actual).toEqual(expected);
  });

  it('can tell admitted from refused: a crashed session is a redirect, not null', async () => {
    mockGetUser.mockRejectedValue(new Error('fixture: session lookup failed'));
    expect(await verdict('/dashboard')).toBe(`${ORIGIN}/login`);
  });
});

describe('a failed membership read', () => {
  it('never signs anyone out and never opens a path above the floor', async () => {
    given([brokerageMembership('admin')], { readFails: true });
    expect(await verdict('/dashboard')).toBeNull();
    given([brokerageMembership('admin')], { readFails: true });
    expect(await verdict('/dashboard/users')).toBe(TO_DASHBOARD);
    // The read really was issued and really did fail.
    expect(mockEmulator.state.selects.map((s) => s.table)).toContain('organization_members');
  });
});
