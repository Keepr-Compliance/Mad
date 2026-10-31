/**
 * The Billing capability table, exhaustively — BACKLOG-3844 (C6, SR R5).
 *
 * Every combination of access persona x impersonation x flag x Agent plan x
 * account suspended x org billing set up is asserted with toEqual on the WHOLE
 * object. The expected values are HAND-WRITTEN rows transcribed from the step-0
 * truth table (pm_comments on BACKLOG-3844), not computed by a second copy of
 * the rule: a computed oracle would share the bug.
 *
 * Access personas are produced by the real classifier from the transcribed
 * PostgREST emulator rows (the same ones the BACKLOG-3080 suites use), so each
 * persona is an access value the portal can actually emit.
 *
 * Fields the truth table leaves blank are ENGINEERING DEFAULTS, fail closed,
 * not product decisions: for an organization without billing set up,
 * canAddSeats and canPurchase are false (nothing to buy against); while the
 * account is suspended a broker/admin cannot add seats and the primary action
 * is "contact support".
 */

import { classifyPortalAccess, type PortalAccess, type PortalMembershipRow } from '@/lib/auth/membership';
import {
  billingCapabilities,
  billingNavVisible,
  type AgentPlanState,
  type BillingCapabilities,
} from '@/lib/billing/capabilities';
import {
  FIXTURE_USER_ID,
  brokerageMembership,
  personalMembership,
  type Row,
} from '../../helpers/postgrestEmulator';

const classify = (rows: Row[] | null): PortalAccess =>
  classifyPortalAccess(rows as PortalMembershipRow[] | null, FIXTURE_USER_ID);

const PERSONAS = {
  'personal-org owner': classify([personalMembership()]),
  'brokerage agent': classify([brokerageMembership('agent')]),
  'brokerage broker': classify([brokerageMembership('broker')]),
  'brokerage admin': classify([brokerageMembership('admin')]),
  'brokerage it_admin': classify([brokerageMembership('it_admin')]),
  'membership read failed': classify(null),
  'no membership': classify([]),
  'impersonation (layout reads no access)': undefined,
} as const;
type Persona = keyof typeof PERSONAS;

// BACKLOG-3860: 'trial' added, so every persona row below is swept for it too.
const PLANS: AgentPlanState[] = ['none', 'active', 'cancel_pending', 'payment_failed', 'support_grant', 'trial'];
const BOOLS = [true, false];

// ---------------------------------------------------------------------------
// Expected objects — written out by hand, one per distinct truth-table row.
// ---------------------------------------------------------------------------

// Truth table row 1: solo, pay as you go.
const P_PAYG: BillingCapabilities = {
  kind: 'personal',
  blocks: ['plan', 'choose_plan', 'credits', 'payment', 'invoices'],
  showPrice: true,
  canPay: true,
  canUpdateCard: true,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: true,
  canManageLicenses: false,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: null,
};
// Row 2: Agent plan active.
const P_ACTIVE: BillingCapabilities = {
  kind: 'personal',
  blocks: ['plan', 'credits', 'payment', 'invoices'],
  showPrice: true,
  canPay: true,
  canUpdateCard: true,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: true,
  canManageLicenses: false,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: 'cancel_plan',
};
// Row 3: cancel pending.
const P_CANCEL_PENDING: BillingCapabilities = {
  kind: 'personal',
  blocks: ['plan', 'credits', 'payment', 'invoices'],
  showPrice: true,
  canPay: true,
  canUpdateCard: true,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: true,
  canManageLicenses: false,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: 'keep_plan',
};
// Row 4: Agent payment failed.
const P_PAYMENT_FAILED: BillingCapabilities = {
  kind: 'personal',
  blocks: ['plan', 'credits', 'payment', 'invoices'],
  showPrice: true,
  canPay: true,
  canUpdateCard: true,
  canEndPlanNow: true,
  canSeeInvoices: true,
  canPurchase: true,
  canManageLicenses: false,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: 'update_card',
};
// Row 5: Unlimited by support grant.
const P_SUPPORT_GRANT: BillingCapabilities = {
  kind: 'personal',
  blocks: ['plan', 'credits', 'payment', 'invoices'],
  showPrice: true,
  canPay: true,
  canUpdateCard: true,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: true,
  canManageLicenses: false,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: null,
};
// Row 6: suspended, pay as you go (choose_plan stays, purchases off).
const P_PAYG_SUSPENDED: BillingCapabilities = {
  kind: 'personal',
  blocks: ['plan', 'choose_plan', 'credits', 'payment', 'invoices'],
  showPrice: true,
  canPay: true,
  canUpdateCard: true,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: false,
  canManageLicenses: false,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: 'contact_support',
};
// Row 6: suspended, on any Agent plan state.
const P_PLAN_SUSPENDED: BillingCapabilities = {
  kind: 'personal',
  blocks: ['plan', 'credits', 'payment', 'invoices'],
  showPrice: true,
  canPay: true,
  canUpdateCard: true,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: false,
  canManageLicenses: false,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: 'contact_support',
};
// Row 8: broker, billing set up.
const BROKER_SET_UP: BillingCapabilities = {
  kind: 'organization',
  blocks: ['plan', 'seats', 'manage_billing'], // BACKLOG-3854: payment + invoices are Stripe's page
  showPrice: true,
  canPay: true,
  canUpdateCard: false,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: true,
  canManageLicenses: true,
  canAddSeats: true,
  showManageUsersLink: false,
  primaryAction: 'add_seats',
};
const BROKER_SET_UP_SUSPENDED: BillingCapabilities = {
  kind: 'organization',
  blocks: ['plan', 'seats', 'manage_billing'], // BACKLOG-3854: payment + invoices are Stripe's page
  showPrice: true,
  canPay: true,
  canUpdateCard: false,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: false,
  canManageLicenses: true,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: 'contact_support',
};
// Row 11 (broker): Managed by Keepr.
const BROKER_NOT_SET_UP: BillingCapabilities = {
  kind: 'organization',
  blocks: ['plan', 'seats'],
  showPrice: true,
  canPay: false,
  canUpdateCard: false,
  canEndPlanNow: false,
  canSeeInvoices: false,
  canPurchase: false,
  canManageLicenses: true,
  canAddSeats: false,
  showManageUsersLink: false,
  primaryAction: null,
};
// Row 9: admin, billing set up.
const ADMIN_SET_UP: BillingCapabilities = {
  kind: 'organization',
  blocks: ['plan', 'seats', 'manage_billing'], // BACKLOG-3854: payment + invoices are Stripe's page
  showPrice: true,
  canPay: true,
  canUpdateCard: false,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: true,
  canManageLicenses: true,
  canAddSeats: true,
  showManageUsersLink: true,
  primaryAction: 'add_seats',
};
const ADMIN_SET_UP_SUSPENDED: BillingCapabilities = {
  kind: 'organization',
  blocks: ['plan', 'seats', 'manage_billing'], // BACKLOG-3854: payment + invoices are Stripe's page
  showPrice: true,
  canPay: true,
  canUpdateCard: false,
  canEndPlanNow: false,
  canSeeInvoices: true,
  canPurchase: false,
  canManageLicenses: true,
  canAddSeats: false,
  showManageUsersLink: true,
  primaryAction: 'contact_support',
};
// Row 11 (admin).
const ADMIN_NOT_SET_UP: BillingCapabilities = {
  kind: 'organization',
  blocks: ['plan', 'seats'],
  showPrice: true,
  canPay: false,
  canUpdateCard: false,
  canEndPlanNow: false,
  canSeeInvoices: false,
  canPurchase: false,
  canManageLicenses: true,
  canAddSeats: false,
  showManageUsersLink: true,
  primaryAction: null,
};
// Rows 10 and 11 (it_admin): never a price, a payment or an invoice.
const IT_ADMIN: BillingCapabilities = {
  kind: 'organization',
  blocks: ['plan', 'seats'],
  showPrice: false,
  canPay: false,
  canUpdateCard: false,
  canEndPlanNow: false,
  canSeeInvoices: false,
  canPurchase: false,
  canManageLicenses: true,
  canAddSeats: false,
  showManageUsersLink: true,
  primaryAction: null,
};

// ---------------------------------------------------------------------------
// The table. '*' = any value of that column. Every case must match EXACTLY one
// row (asserted below), so row order can never decide an answer.
// ---------------------------------------------------------------------------

type W<T> = T | '*';
interface ExpectedRow {
  enabled: W<boolean>;
  impersonating: W<boolean>;
  persona: W<Persona>;
  plan: W<AgentPlanState>;
  suspended: W<boolean>;
  setUp: W<boolean>;
  expected: BillingCapabilities | null;
}
const row = (
  enabled: W<boolean>,
  impersonating: W<boolean>,
  persona: W<Persona>,
  plan: W<AgentPlanState>,
  suspended: W<boolean>,
  setUp: W<boolean>,
  expected: BillingCapabilities | null
): ExpectedRow => ({ enabled, impersonating, persona, plan, suspended, setUp, expected });

const TABLE: ExpectedRow[] = [
  // Row 17: flag off -> 404 for everyone.
  row(false, '*', '*', '*', '*', '*', null),
  // Row 12: support / impersonation -> 404 for everyone.
  row(true, true, '*', '*', '*', '*', null),
  // Rows 7, 13, 14, and the impersonation layout state: never a billing page.
  row(true, false, 'brokerage agent', '*', '*', '*', null),
  row(true, false, 'membership read failed', '*', '*', '*', null),
  row(true, false, 'no membership', '*', '*', '*', null),
  row(true, false, 'impersonation (layout reads no access)', '*', '*', '*', null),
  // Rows 1-6: the personal owner. orgBillingSetUp does not apply.
  row(true, false, 'personal-org owner', 'none', false, '*', P_PAYG),
  row(true, false, 'personal-org owner', 'active', false, '*', P_ACTIVE),
  row(true, false, 'personal-org owner', 'cancel_pending', false, '*', P_CANCEL_PENDING),
  row(true, false, 'personal-org owner', 'payment_failed', false, '*', P_PAYMENT_FAILED),
  row(true, false, 'personal-org owner', 'support_grant', false, '*', P_SUPPORT_GRANT),
  row(true, false, 'personal-org owner', 'none', true, '*', P_PAYG_SUSPENDED),
  row(true, false, 'personal-org owner', 'active', true, '*', P_PLAN_SUSPENDED),
  row(true, false, 'personal-org owner', 'cancel_pending', true, '*', P_PLAN_SUSPENDED),
  row(true, false, 'personal-org owner', 'payment_failed', true, '*', P_PLAN_SUSPENDED),
  row(true, false, 'personal-org owner', 'support_grant', true, '*', P_PLAN_SUSPENDED),
  // BACKLOG-3860 T9b: a live trial reads exactly like pay as you go (Choose a plan, can purchase).
  row(true, false, 'personal-org owner', 'trial', false, '*', P_PAYG),
  row(true, false, 'personal-org owner', 'trial', true, '*', P_PAYG_SUSPENDED),
  // Rows 8-11: the organization. The personal Agent plan does not apply.
  row(true, false, 'brokerage broker', '*', false, true, BROKER_SET_UP),
  row(true, false, 'brokerage broker', '*', true, true, BROKER_SET_UP_SUSPENDED),
  row(true, false, 'brokerage broker', '*', '*', false, BROKER_NOT_SET_UP),
  row(true, false, 'brokerage admin', '*', false, true, ADMIN_SET_UP),
  row(true, false, 'brokerage admin', '*', true, true, ADMIN_SET_UP_SUSPENDED),
  row(true, false, 'brokerage admin', '*', '*', false, ADMIN_NOT_SET_UP),
  row(true, false, 'brokerage it_admin', '*', '*', '*', IT_ADMIN),
];

interface Case {
  enabled: boolean;
  impersonating: boolean;
  persona: Persona;
  plan: AgentPlanState;
  suspended: boolean;
  setUp: boolean;
}

const CASES: Case[] = [];
for (const enabled of BOOLS)
  for (const impersonating of BOOLS)
    for (const persona of Object.keys(PERSONAS) as Persona[])
      for (const plan of PLANS)
        for (const suspended of BOOLS)
          for (const setUp of BOOLS) CASES.push({ enabled, impersonating, persona, plan, suspended, setUp });

const matches = <T>(want: W<T>, got: T) => want === '*' || want === got;
function expectedFor(c: Case): BillingCapabilities | null {
  const hits = TABLE.filter(
    (r) =>
      matches(r.enabled, c.enabled) &&
      matches(r.impersonating, c.impersonating) &&
      matches(r.persona, c.persona) &&
      matches(r.plan, c.plan) &&
      matches(r.suspended, c.suspended) &&
      matches(r.setUp, c.setUp)
  );
  if (hits.length !== 1) throw new Error(`${hits.length} table rows match ${JSON.stringify(c)}`);
  return hits[0].expected;
}

const label = (c: Case) =>
  `${c.persona} | flag ${c.enabled} | impersonating ${c.impersonating} | plan ${c.plan} | suspended ${c.suspended} | set up ${c.setUp}`;

describe('billingCapabilities — the whole table', () => {
  it('sweeps every case, and every case matches exactly one hand-written row', () => {
    expect(CASES.length).toBe(8 * 2 * 2 * 6 * 2 * 2); // 6 plans since BACKLOG-3860 (trial)
    for (const c of CASES) expectedFor(c);
  });

  it('the personas are the access values the classifier emits', () => {
    expect(PERSONAS['personal-org owner']).toMatchObject({ kind: 'floor', via: 'personal_owner', role: 'agent' });
    expect(PERSONAS['brokerage agent']).toMatchObject({ kind: 'floor', via: 'brokerage', role: 'agent' });
    expect(PERSONAS['brokerage broker']).toMatchObject({ kind: 'full', role: 'broker' });
    expect(PERSONAS['brokerage admin']).toMatchObject({ kind: 'full', role: 'admin' });
    expect(PERSONAS['brokerage it_admin']).toMatchObject({ kind: 'full', role: 'it_admin' });
    expect(PERSONAS['membership read failed']).toEqual({ kind: 'unknown' });
    expect(PERSONAS['no membership']).toEqual({ kind: 'none' });
  });

  it.each(CASES.map((c) => [label(c), c] as const))('%s', (_label, c) => {
    expect(
      billingCapabilities({
        access: PERSONAS[c.persona],
        isImpersonating: c.impersonating,
        enabled: c.enabled,
        agentPlan: c.plan,
        accountSuspended: c.suspended,
        orgBillingSetUp: c.setUp,
      })
    ).toEqual(expectedFor(c));
  });
});

describe('3848 SR RC4: an unpaid subscription', () => {
  const owner = { access: PERSONAS['personal-org owner'], isImpersonating: false, enabled: true, agentPlan: 'payment_failed' as const, accountSuspended: false, orgBillingSetUp: false };
  it('renewalUnpaid -> End plan now is not offered; everything else as payment_failed', () => {
    expect(billingCapabilities({ ...owner, renewalUnpaid: true })).toEqual({ ...P_PAYMENT_FAILED, canEndPlanNow: false });
  });
  it('control: renewalUnpaid false -> End plan now offered (row 4)', () => {
    expect(billingCapabilities({ ...owner, renewalUnpaid: false })).toEqual(P_PAYMENT_FAILED);
  });
});

describe('billingNavVisible — the sidebar asks the same question as the page (C6b)', () => {
  const navCases = CASES.filter((c) => c.plan === 'none' && !c.suspended && !c.setUp);

  it.each(navCases.map((c) => [label(c), c] as const))('%s', (_label, c) => {
    const pageAdmits = CASES.filter(
      (x) => x.persona === c.persona && x.enabled === c.enabled && x.impersonating === c.impersonating
    ).some((x) => expectedFor(x) !== null);
    expect(
      billingNavVisible({ access: PERSONAS[c.persona], isImpersonating: c.impersonating, enabled: c.enabled })
    ).toBe(pageAdmits);
  });

  // Hand-written: who sees the entry with the flag on and no support session.
  it.each([
    ['personal-org owner', true],
    ['brokerage broker', true],
    ['brokerage admin', true],
    ['brokerage it_admin', true],
    ['brokerage agent', false],
    ['membership read failed', false],
    ['no membership', false],
    ['impersonation (layout reads no access)', false],
  ] as [Persona, boolean][])('%s -> %s', (persona, visible) => {
    expect(billingNavVisible({ access: PERSONAS[persona], isImpersonating: false, enabled: true })).toBe(visible);
  });
});

describe('BACKLOG-3860 T9b: a live free trial may subscribe', () => {
  const owner = { access: PERSONAS['personal-org owner'], isImpersonating: false, enabled: true, accountSuspended: false, orgBillingSetUp: false };
  it('trial -> Choose a plan present, canPurchase true, no primary action on Your plan', () => {
    const caps = billingCapabilities({ ...owner, agentPlan: 'trial' })!;
    expect(caps.blocks).toContain('choose_plan');
    expect(caps.canPurchase).toBe(true);
    expect(caps.primaryAction).toBeNull();
  });
  it.each([
    ['none', P_PAYG],
    ['active', P_ACTIVE],
    ['support_grant', P_SUPPORT_GRANT],
  ] as [AgentPlanState, BillingCapabilities][])('control: %s unchanged', (plan, expected) => {
    expect(billingCapabilities({ ...owner, agentPlan: plan })).toEqual(expected);
  });
});
