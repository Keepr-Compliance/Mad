/**
 * admin_get_org_billing shapes for BACKLOG-4007 PR-2, transcribed from keepr-test on 2026-10-20
 * (migration 20261020100000 applied), with names, emails and ids replaced.
 *  - WAITING: a new deal saved through admin_save_deal (10 args, start date business_date + 5),
 *    in a rolled-back transaction: status 'draft', state 'waiting_for_setup', no contact.
 *  - ACTIVE: "Test Brokerage Alpha" (deal saved before 4007, contact backfilled with no phone).
 * account_managers and log were cut from the capture; they are set empty here.
 * business_date is moved to 2030 in the tests that check the picker, so a renderer that used
 * the machine's own "today" instead of business_date cannot pass by coincidence.
 */
import type { OrgBilling, OrgDeal } from '@/lib/billing/dealRules';

export const WAITING_DEAL: OrgDeal = {
  organization_id: 'org-waiting', stripe_mode: 'test', status: 'draft', seats: 3, start_date: '2026-10-24',
  account_manager_id: null, billing_contact_name: null, billing_contact_email: null,
  suspended_at: null, suspended_reason: null, suspended_note: null, version: 1,
  billing_starts_on: null, setup_completed_at: null, billing_contact_id: null,
};

export const WAITING: OrgBilling = {
  billing_live: false, is_test: true, list_price_cents: 2499, cap_pct: 20,
  can_manage: true, can_approve: true, can_suspend: true, assigned_seats: 0,
  business_date: '2026-10-19', state: 'waiting_for_setup', contact: null, company: null, terms_accepted: null,
  deal: WAITING_DEAL,
  seat_line: { unit_price_cents: 2499, list_price_cents_at_save: 2499, pct_off: 0 },
  stripe: null, account_managers: [], log: [],
};

export const ACTIVE_DEAL: OrgDeal = {
  organization_id: 'org-active', stripe_mode: 'test', status: 'active', seats: 7, start_date: '2026-10-19',
  account_manager_id: 'am-1', billing_contact_name: 'billing team', billing_contact_email: 'billing@example.test',
  suspended_at: null, suspended_reason: null, suspended_note: null, version: 2,
  billing_starts_on: null, setup_completed_at: null, billing_contact_id: 'contact-1',
};

export const ACTIVE: OrgBilling = {
  ...WAITING,
  assigned_seats: 1, state: 'active',
  contact: { id: 'contact-1', name: 'billing team', email: 'billing@example.test', phone: null, has_login: false },
  deal: ACTIVE_DEAL,
  stripe: { stripe_mode: 'test', status: 'active', current_period_end: '2026-11-19T21:29:07+00:00', cancel_at_period_end: false },
};

export const NO_DEAL: OrgBilling = { ...WAITING, state: null, deal: null, seat_line: null };
