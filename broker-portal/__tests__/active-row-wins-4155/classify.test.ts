/**
 * BACKLOG-4155 — the deciding brokerage row: an active row anywhere wins, else
 * an unassigned row, else the first row.
 *
 * Mirrors the database's unlock guard (refuse iff ANY brokerage row is
 * 'unassigned' and NONE grants). Every two-row case runs in BOTH row orders.
 *
 * Fixtures: org A rows come from helpers/postgrestEmulator.ts
 * (`brokerageMembership`, transcribed PORTAL_MEMBERSHIP_SELECT embed, case B
 * post-migration). Org B is the same transcribed embed with a distinct id and
 * name (personal_owner_user_id stays null): a second brokerage.
 *
 * @jest-environment node
 */

import {
  BROKERAGE_ORG_POST,
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  personalMembership,
  type Row,
} from '../helpers/postgrestEmulator';
import { classifyPortalAccess, pickBrokerageMembership, type PortalMembershipRow } from '@keepr/shared';
import { mayBeBillingContact, readBillingContactLogin } from '@/lib/auth/billingContact';

const U = FIXTURE_USER_ID;
const A = FIXTURE_BROKERAGE_ORG_ID;
const B = '00000000-0000-4000-8000-0000004155b0'; // pii-allow-uuid: invented fixture id

/** A row at brokerage A (the transcribed embed). */
function atA(status: string | null, role = 'agent'): Row {
  return { ...brokerageMembership(role), license_status: status };
}
/** A row at brokerage B: same transcribed embed, distinct id and name. */
function atB(status: string | null, role = 'agent'): Row {
  return {
    ...brokerageMembership(role),
    id: `${B}-${role}`,
    organization_id: B,
    license_status: status,
    organizations: { ...BROKERAGE_ORG_POST, id: B, name: 'Second Fixture Brokerage 4155' },
  };
}
const rows = (...r: Row[]) => r as unknown as PortalMembershipRow[];
const classify = (...r: Row[]) => classifyPortalAccess(rows(...r), U);

/** Both orders of a two-row case. */
function bothOrders(x: Row, y: Row, extra: Row[] = []): [string, Row[]][] {
  return [
    ['A first', [x, y, ...extra]],
    ['B first', [y, x, ...extra]],
  ];
}

describe('C1 unassigned at A + active at B: B decides (allowed)', () => {
  it.each(bothOrders(atA('unassigned'), atB('active')))('%s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'floor', via: 'brokerage', role: 'agent', organizationId: B });
    expect(pickBrokerageMembership(rows(...r))?.organization_id).toBe(B);
  });
  it.each(bothOrders(atA('unassigned'), atB('active', 'broker')))('%s, broker at B -> full on B', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'full', role: 'broker', organizationId: B });
  });
});

describe('C2 active at A + unassigned at B: A decides (allowed)', () => {
  it.each(bothOrders(atA('active'), atB('unassigned')))('%s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'floor', via: 'brokerage', role: 'agent', organizationId: A });
  });
});

describe('C3 suspended at A + unassigned at B: refused (unlicensed on B)', () => {
  it.each(bothOrders(atA('suspended'), atB('unassigned'), [personalMembership()]))('C3a with own personal row, %s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'floor', via: 'unlicensed', role: 'agent', organizationId: B });
  });
  it.each(bothOrders(atA('suspended'), atB('unassigned')))('C3b no personal row, %s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'floor', via: 'unlicensed', role: 'agent', organizationId: B });
  });
  it.each(bothOrders(atA('expired'), atB('unassigned'), [personalMembership()]))('expired twin with own personal row, %s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toMatchObject({ kind: 'floor', via: 'unlicensed', organizationId: B });
  });
});

describe('C4 unassigned at A + suspended at B: refused (unlicensed on A)', () => {
  it.each(bothOrders(atA('unassigned'), atB('suspended'), [personalMembership()]))('with own personal row, %s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'floor', via: 'unlicensed', role: 'agent', organizationId: A });
  });
});

// C5 is DEFENSIVE ONLY: no writer produces a pending row with a user_id today
// (invites are pending with user_id null). Not counted toward catching M2.
describe('C5 (defensive) pending at A + unassigned at B: refused', () => {
  it.each(bothOrders(atA('pending'), atB('unassigned'), [personalMembership()]))('%s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toMatchObject({ kind: 'floor', via: 'unlicensed', organizationId: B });
  });
});

describe('C6 suspended at A + active at B: B decides', () => {
  it.each(bothOrders(atA('suspended'), atB('active'), [personalMembership()]))('with own personal row, %s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'floor', via: 'brokerage', role: 'agent', organizationId: B });
  });
  it.each(bothOrders(atA('suspended'), atB('active')))('no personal row, %s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'floor', via: 'brokerage', role: 'agent', organizationId: B });
  });
});

describe('C7 pending at A + active at B: B decides', () => {
  it.each(bothOrders(atA('pending'), atB('active', 'admin')))('%s', (_o, r) => {
    expect(classifyPortalAccess(rows(...r), U)).toEqual({ kind: 'full', role: 'admin', organizationId: B });
  });
});

describe('tier 3 stays order-dependent (pre-existing, pinned)', () => {
  it('pending at A first + suspended at B + own personal row -> deactivated on A', () => {
    expect(classify(atA('pending'), atB('suspended'), personalMembership())).toEqual({
      kind: 'floor',
      via: 'deactivated',
      role: 'agent',
      organizationId: A,
    });
  });
  it('suspended at B first + pending at A + own personal row -> personal_owner', () => {
    expect(classify(atB('suspended'), atA('pending'), personalMembership())).toEqual({
      kind: 'floor',
      via: 'personal_owner',
      role: 'agent',
      organizationId: FIXTURE_PERSONAL_ORG_ID,
    });
  });
});

describe('single-row and no-brokerage users: unchanged', () => {
  it.each<[string, Row[], object]>([
    ['active', [atA('active')], { kind: 'floor', via: 'brokerage', organizationId: A }],
    ['unassigned', [atA('unassigned')], { kind: 'floor', via: 'unlicensed', organizationId: A }],
    ['suspended, no personal', [atA('suspended')], { kind: 'floor', via: 'deactivated', organizationId: A }],
    ['suspended + own personal', [atA('suspended'), personalMembership()], { kind: 'floor', via: 'personal_owner' }],
    ['pending', [atA('pending')], { kind: 'floor', via: 'deactivated', organizationId: A }],
    ['null status', [atA(null)], { kind: 'floor', via: 'deactivated', organizationId: A }],
    ['personal only', [personalMembership()], { kind: 'floor', via: 'personal_owner' }],
    ['no rows', [], { kind: 'none' }],
  ])('%s', (_l, r, expected) => {
    expect(classifyPortalAccess(rows(...r), U)).toMatchObject(expected);
  });
  it('error result -> unknown, no pick', () => {
    expect(classifyPortalAccess(null, U)).toEqual({ kind: 'unknown' });
    expect(pickBrokerageMembership(null)).toBeNull();
  });
  it('two active rows: the first still decides (order tie-break)', () => {
    expect(pickBrokerageMembership(rows(atA('active'), atB('active')))?.organization_id).toBe(A);
    expect(pickBrokerageMembership(rows(atB('active'), atA('active')))?.organization_id).toBe(B);
  });
});

describe('billing-only login (SR change 6): an unassigned billing row at A is NOT a billing contact once B is active', () => {
  const billingOnlyA = (): Row => ({ ...atA('unassigned'), provisioned_by: 'invite', provisioning_metadata: { billing_only: true } });

  it.each(bothOrders(billingOnlyA(), atB('active')))('%s: not asked, no RPC', async (_o, r) => {
    const access = classifyPortalAccess(rows(...r), U);
    expect(mayBeBillingContact(access)).toBe(false);
    const rpc = jest.fn();
    await expect(readBillingContactLogin({ rpc }, access)).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('twin: billing-only row alone is still asked, against A', async () => {
    const access = classify(billingOnlyA());
    expect(mayBeBillingContact(access)).toBe(true);
    const rpc = jest.fn(async () => ({ data: true, error: null }));
    await expect(readBillingContactLogin({ rpc }, access)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('org_billing_contact_login', { p_org: A });
  });
});
