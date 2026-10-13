/**
 * Who sees the Billing page, and which blocks it shows — BACKLOG-3844.
 *
 * Pure: no I/O, no environment read, no imports except types. The page, the
 * dashboard layout (sidebar entry) and the tests all call these two functions,
 * so the sidebar and the page cannot disagree about WHO is admitted.
 *
 * Who (the access dimension, from classifyPortalAccess in lib/auth/membership.ts):
 *   - the OWNER of a personal organization  -> the personal page;
 *   - a full-portal user (broker, admin, it_admin) -> the organization page;
 *   - everyone else -> null (the page answers 404): a brokerage agent (their
 *     brokerage pays; founder decision, no billing page at all), a failed
 *     membership read (fail closed), no membership, and any support /
 *     impersonation session (the access is never read while impersonating).
 *   The flag (lib/billing/flag.ts) is passed in as `enabled`; off -> null.
 *
 * Which (the situation, fixed in 3844 by the page and read for real by later
 * slices: agentPlan by 3847, accountSuspended by 3878, orgBillingSetUp by
 * 3853/3855):
 *   - personal, no Agent plan: plan, choose_plan, credits, payment, invoices;
 *     with an Agent plan (any state): plan, credits, payment, invoices.
 *   - organization, broker/admin with billing set up: plan, seats, payment,
 *     invoices. it_admin: plan, seats, and never a price or an invoice.
 *     Billing not set up yet ("Managed by Keepr"): plan, seats only.
 *   - account suspended: nothing can be bought; a purchasing primary action
 *     becomes "contact support".
 */

import type { PortalAccess } from '@/lib/auth/membership';

export type BillingBlock = 'plan' | 'choose_plan' | 'seats' | 'credits' | 'payment' | 'invoices';

/** The personal Agent plan as billing_subscriptions will report it (3847). */
export type AgentPlanState = 'none' | 'active' | 'cancel_pending' | 'payment_failed' | 'support_grant';

export type BillingPrimaryAction =
  | 'cancel_plan'
  | 'keep_plan'
  | 'update_card'
  | 'contact_support'
  | 'add_seats';

export interface BillingSituation {
  /** undefined during impersonation: the layout never reads access then. */
  access: PortalAccess | undefined;
  isImpersonating: boolean;
  /** billingEnabled(), computed on the server. */
  enabled: boolean;
  agentPlan: AgentPlanState;
  /**
   * BACKLOG-3848 (SR RC4): the Agent subscription is `unpaid` (all retries
   * failed). agentPlan reads `payment_failed` for it, but End plan now's
   * void/cancel path refuses `unpaid` (untraced in TEST), so the button is
   * hidden and the page sends the person to support instead.
   */
  renewalUnpaid?: boolean;
  accountSuspended: boolean;
  /** The organization has a billing deal on record (org_deals, 3853). */
  orgBillingSetUp: boolean;
}

export interface BillingCapabilities {
  kind: 'personal' | 'organization';
  /** Render order. */
  blocks: BillingBlock[];
  showPrice: boolean;
  /** Payment method and billing contact are shown and editable. */
  canPay: boolean;
  /** BACKLOG-3848: the personal owner may replace the saved card (Stripe-hosted setup page). */
  canUpdateCard: boolean;
  /**
   * BACKLOG-3848 (founder Q1 = A, SR R6): an Agent plan whose renewal payment
   * failed may be ended now (unpaid renewal voided, then cancelled). Reads the
   * plan state only; a suspended account is BACKLOG-3878's, so it is false here.
   */
  canEndPlanNow: boolean;
  canSeeInvoices: boolean;
  canPurchase: boolean;
  canManageLicenses: boolean;
  canAddSeats: boolean;
  showManageUsersLink: boolean;
  primaryAction: BillingPrimaryAction | null;
}

/** Roles that pay for an organization. it_admin manages seats but never money. */
const ORG_PAYER_ROLES = ['broker', 'admin'] as const;
const ORG_ROLES = ['broker', 'admin', 'it_admin'] as const;

const PERSONAL_PRIMARY: Record<AgentPlanState, BillingPrimaryAction | null> = {
  // Block 2 (Choose a plan) carries Subscribe for a pay-as-you-go owner, so block 1 has no
  // primary action then (founder decision 2026-10-12).
  none: null,
  active: 'cancel_plan',
  cancel_pending: 'keep_plan',
  payment_failed: 'update_card',
  support_grant: null,
};

function personal(s: BillingSituation): BillingCapabilities {
  const blocks: BillingBlock[] =
    s.agentPlan === 'none'
      ? ['plan', 'choose_plan', 'credits', 'payment', 'invoices']
      : ['plan', 'credits', 'payment', 'invoices'];
  return {
    kind: 'personal',
    blocks,
    showPrice: true,
    canPay: true,
    canUpdateCard: true,
    canEndPlanNow: !s.accountSuspended && s.agentPlan === 'payment_failed' && !s.renewalUnpaid,
    canSeeInvoices: true,
    canPurchase: !s.accountSuspended,
    canManageLicenses: false,
    canAddSeats: false,
    showManageUsersLink: false,
    primaryAction: s.accountSuspended ? 'contact_support' : PERSONAL_PRIMARY[s.agentPlan],
  };
}

function organization(role: string, s: BillingSituation): BillingCapabilities {
  const payer = (ORG_PAYER_ROLES as readonly string[]).includes(role);
  // Money only for a payer whose organization has billing set up.
  const money = payer && s.orgBillingSetUp;
  const canPurchase = money && !s.accountSuspended;
  return {
    kind: 'organization',
    blocks: money ? ['plan', 'seats', 'payment', 'invoices'] : ['plan', 'seats'],
    showPrice: payer,
    canPay: money,
    // Organization payment and plan changes are BACKLOG-3855's.
    canUpdateCard: false,
    canEndPlanNow: false,
    canSeeInvoices: money,
    canPurchase,
    canManageLicenses: true,
    canAddSeats: canPurchase,
    showManageUsersLink: role === 'admin' || role === 'it_admin',
    primaryAction: money ? (s.accountSuspended ? 'contact_support' : 'add_seats') : null,
  };
}

/** What the Billing page shows this person, or null when it must answer 404. */
export function billingCapabilities(s: BillingSituation): BillingCapabilities | null {
  if (!s.enabled || s.isImpersonating || !s.access) return null;
  const a = s.access;
  if (a.kind === 'floor' && a.via === 'personal_owner') return personal(s);
  if (a.kind === 'full' && (ORG_ROLES as readonly string[]).includes(a.role)) {
    return organization(a.role, s);
  }
  return null;
}

/**
 * Whether the sidebar shows Billing. The same rule as the page, on the access
 * dimension only: the situation changes WHICH blocks, never WHO.
 */
export function billingNavVisible(
  s: Pick<BillingSituation, 'access' | 'isImpersonating' | 'enabled'>
): boolean {
  return (
    billingCapabilities({
      ...s,
      agentPlan: 'none',
      accountSuspended: false,
      orgBillingSetUp: false,
    }) !== null
  );
}
