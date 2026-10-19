/**
 * BACKLOG-3859 fixtures — rows as PostgREST returns them to lib/planLines.ts.
 *
 * Provenance (prod reads, SELECT only, 2026-10-14):
 *   - organization_members: the two member rows of the flagged test org
 *     (brokerage admin + agent, license_status 'active', org is_test true).
 *     Column values copied; ids, names and timestamps of OTHER users invented.
 *     The org name is replaced (public repo).
 *   - billing_subscriptions: the shape of the TEST-mode rows (status active /
 *     incomplete_expired, interval 'month', cancel_at_period_end false,
 *     canceled_at null or set). Period dates are those of the captured TEST
 *     subscription broker-portal/__tests__/fixtures/stripe/p3847/sub-C-keep.json
 *     (current_period_end 2026-11-12T19:45:47Z) and
 *     sub-C-cancel-at-period-end.json (canceled_at 2026-10-12T19:46:23Z).
 *   - organization_plans.feature_overrides.unlimited_transactions: the two
 *     shapes in prod — { enabled } (support grant, no source) and
 *     { enabled, paid_through, source: 'stripe' }.
 *   - organizations (personal): id, personal_owner_user_id, is_test.
 *
 * SYNTHETIC, with the reason:
 *   - a personal organization for a brokerage member: the flagged test org's
 *     members own none in prod; needed for "brokerage wins".
 *   - a second, later brokerage row for one user (reachable: SCIM + directory sync).
 *   - licenses status 'suspended': 0 such rows exist in prod.
 *   - a 'past_due' row: none exists in prod; the status is Stripe's.
 */

export const NOW = new Date('2026-10-14T12:00:00Z');

// Invented ids (fixture only).
export const U_BROKER = '00000000-0000-4000-8000-000000385911'; // pii-allow-uuid: invented fixture id
export const U_AGENT = '00000000-0000-4000-8000-000000385912'; // pii-allow-uuid: invented fixture id
export const U_SOLO_PAID = '00000000-0000-4000-8000-000000385913'; // pii-allow-uuid: invented fixture id
export const U_SOLO_LIVE = '00000000-0000-4000-8000-000000385914'; // pii-allow-uuid: invented fixture id
export const U_GRANT = '00000000-0000-4000-8000-000000385915'; // pii-allow-uuid: invented fixture id
export const U_STALE = '00000000-0000-4000-8000-000000385916'; // pii-allow-uuid: invented fixture id
export const U_NOBODY = '00000000-0000-4000-8000-000000385917'; // pii-allow-uuid: invented fixture id
export const U_NOMEMBER = '00000000-0000-4000-8000-000000385918'; // pii-allow-uuid: invented fixture id
export const STAFF = '00000000-0000-4000-8000-000000385999'; // pii-allow-uuid: invented fixture id

export const BROKERAGE_ORG = '00000000-0000-4000-8000-0000003859a1'; // pii-allow-uuid: invented fixture id
export const BROKERAGE_ORG_2 = '00000000-0000-4000-8000-0000003859a2'; // pii-allow-uuid: invented fixture id
const P = (n: number) => `00000000-0000-4000-8000-0000003859b${n}`; // personal org ids, invented

export type Row = Record<string, unknown>;

const brokerageEmbed = { name: 'Demo Realty', personal_owner_user_id: null };
const secondBrokerageEmbed = { name: 'Second Brokerage', personal_owner_user_id: null };

export const BASE_TABLES: Record<string, Row[]> = {
  organization_members: [
    // Transcribed: the flagged test org's admin and agent rows (role, license_status, created_at order).
    { id: 'm-1', user_id: U_BROKER, role: 'admin', organization_id: BROKERAGE_ORG, license_status: 'active', created_at: '2026-10-10T16:24:29.154388+00:00', organizations: brokerageEmbed },
    { id: 'm-2', user_id: U_AGENT, role: 'agent', organization_id: BROKERAGE_ORG, license_status: 'active', created_at: '2026-10-10T16:27:11.72815+00:00', organizations: brokerageEmbed },
    // SYNTHETIC: a SECOND, later brokerage row for the broker (SCIM and directory
    // sync can both write one). The FIRST by created_at, id must decide (C8).
    { id: 'm-9', user_id: U_BROKER, role: 'agent', organization_id: BROKERAGE_ORG_2, license_status: 'expired', created_at: '2026-10-11T09:00:00+00:00', organizations: secondBrokerageEmbed },
    // SYNTHETIC: the agent also owns a personal org, created BEFORE the brokerage row.
    { id: 'm-0', user_id: U_AGENT, role: 'owner', organization_id: P(2), license_status: 'active', created_at: '2026-10-01T00:00:00+00:00', organizations: { name: 'Agent personal', personal_owner_user_id: U_AGENT } },
    { id: 'm-3', user_id: U_SOLO_PAID, role: 'owner', organization_id: P(3), license_status: 'active', created_at: '2026-10-12T22:10:00+00:00', organizations: { name: 'Solo personal', personal_owner_user_id: U_SOLO_PAID } },
    { id: 'm-4', user_id: U_SOLO_LIVE, role: 'owner', organization_id: P(4), license_status: 'active', created_at: '2026-10-12T22:10:00+00:00', organizations: { name: 'Live personal', personal_owner_user_id: U_SOLO_LIVE } },
    { id: 'm-5', user_id: U_GRANT, role: 'owner', organization_id: P(5), license_status: 'active', created_at: '2026-10-12T22:10:00+00:00', organizations: { name: 'Grant personal', personal_owner_user_id: U_GRANT } },
    { id: 'm-6', user_id: U_STALE, role: 'owner', organization_id: P(6), license_status: 'active', created_at: '2026-10-12T22:10:00+00:00', organizations: { name: 'Stale personal', personal_owner_user_id: U_STALE } },
    // U_NOMEMBER owns a personal org but has NO member row (R5: still found).
  ],
  organizations: [
    { id: P(2), personal_owner_user_id: U_AGENT, is_test: true },
    { id: P(3), personal_owner_user_id: U_SOLO_PAID, is_test: true },
    { id: P(4), personal_owner_user_id: U_SOLO_LIVE, is_test: false },
    { id: P(5), personal_owner_user_id: U_GRANT, is_test: true },
    { id: P(6), personal_owner_user_id: U_STALE, is_test: true },
    { id: P(8), personal_owner_user_id: U_NOMEMBER, is_test: true },
  ],
  billing_subscriptions: [
    // Transcribed shape: TEST-mode active monthly row (sub-C-keep dates).
    { user_id: U_SOLO_PAID, stripe_mode: 'test', stripe_subscription_id: 'sub_fx_paid', status: 'active', interval: 'month', current_period_end: '2026-11-12T19:45:47+00:00', cancel_at_period_end: false, canceled_at: null },
    // The same shape for a user in a NON-test org: test mode is not their mode (C9).
    { user_id: U_SOLO_LIVE, stripe_mode: 'test', stripe_subscription_id: 'sub_fx_live', status: 'active', interval: 'month', current_period_end: '2026-11-12T19:45:47+00:00', cancel_at_period_end: false, canceled_at: null },
    // R5: owner with no member row, cancel at period end (sub-C-cancel-at-period-end dates).
    { user_id: U_NOMEMBER, stripe_mode: 'test', stripe_subscription_id: 'sub_fx_nomember', status: 'active', interval: 'month', current_period_end: '2026-11-12T19:45:47+00:00', cancel_at_period_end: true, canceled_at: '2026-10-12T19:46:23+00:00' },
    // A brokerage member's own paid row: brokerage still wins (C8).
    { user_id: U_AGENT, stripe_mode: 'test', stripe_subscription_id: 'sub_fx_agent', status: 'active', interval: 'month', current_period_end: '2026-11-12T19:45:47+00:00', cancel_at_period_end: false, canceled_at: null },
  ],
  organization_plans: [
    { organization_id: P(3), feature_overrides: { unlimited_transactions: { source: 'stripe', enabled: true, paid_through: '2026-11-13T02:36:40+00:00' } } },
    { organization_id: P(5), feature_overrides: { unlimited_transactions: { enabled: true } } },
    // Q4: Unlimited on from Stripe, but no open subscription row (U_STALE has none).
    { organization_id: P(6), feature_overrides: { unlimited_transactions: { source: 'stripe', enabled: true, paid_through: '2026-11-13T00:13:44+00:00' } } },
  ],
  licenses: [],
};

export const ALL_USERS = [U_BROKER, U_AGENT, U_SOLO_PAID, U_SOLO_LIVE, U_GRANT, U_STALE, U_NOBODY, U_NOMEMBER];
