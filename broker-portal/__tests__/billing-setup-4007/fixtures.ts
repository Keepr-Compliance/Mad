/**
 * BACKLOG-4007 PR-3 fixtures.
 *
 * SETUP_VIEW_WAITING is broker_get_billing_setup(p_org) as keepr-test returned it on 2026-10-20 for a
 * paid deal saved by staff through the 10-arg admin_save_deal (supabase/tests/backlog-4007-pr3/
 * results-2026-10-20.txt, "fx_view"). `me`, `account_manager` and `contact` were dropped from the
 * capture (personal fields); they are added back here with invented values in the shape the
 * function builds them (migration 20261020100000:695-701): contact is null until setup.
 */
import type { BillingSetupView } from '@/lib/billing/setupState';

export const SETUP_VIEW_WAITING: BillingSetupView = {
  seats: 5,
  state: 'waiting_for_setup',
  company: null,
  success: true,
  version: 1,
  plan_name: 'Team',
  start_date: '2026-10-20',
  unit_price_cents: 2499,
  billing_starts_on: '2026-10-20',
  monthly_total_cents: 12495,
  account_manager: 'Account Manager',
  contact: null,
  me: { name: 'fixture broker', email: 'broker-4007@example.test' },
};

export const SETUP_VIEW_ACTIVE: BillingSetupView = { ...SETUP_VIEW_WAITING, state: 'active', version: 2 };
