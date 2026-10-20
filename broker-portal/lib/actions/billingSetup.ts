'use server';

/**
 * Billing step of the brokerage setup guide — BACKLOG-4007 PR-3.
 *
 * completeBillingSetup records the Terms acceptance and completes setup in ONE request with the
 * signed-in user's client: broker_accept_terms then broker_complete_billing_setup, both for the
 * deal version the step showed (acceptance is caller-scoped; the RPC refuses a stale version).
 * Seats and price are never sent: the database reads them from the deal.
 *
 * askAboutPrice queues one "question about the price" email to the account manager
 * (billing outbox kind notify_account_manager, reason price_question), at most one per person
 * per day. Setup can continue or be left.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import { enqueueOutbox } from '@/lib/billing/outboxEnqueue';
import { NOTIFY_ACCOUNT_MANAGER_KIND } from '@/lib/billing/brokerageNotify';
import { SETUP_ROLES } from '@/lib/billing/setupState';
import { TERMS_URL, TERMS_VERSION, billingSetupErrorMessage } from '@/lib/billing/setupCopy';

export interface BillingSetupContactInput {
  who: 'me' | 'other';
  name?: string;
  email?: string;
  phone: string;
}

export interface BillingSetupCompanyInput {
  legal_name: string;
  address_line1: string;
  address_line2?: string;
  city: string;
  region?: string;
  postal_code: string;
  country: string;
  po_number?: string;
}

export interface CompleteBillingSetupInput {
  organizationId: string;
  expectedVersion: number;
  acceptTerms: boolean;
  contact: BillingSetupContactInput;
  company: BillingSetupCompanyInput;
}

export type BillingSetupResult =
  | { success: true; billingStartsOn: string }
  | { success: false; error: string; code: string; reload?: boolean };

type RpcResult = { success?: boolean; error?: string; billing_starts_on?: string } | null;

function fail(code: string): BillingSetupResult {
  return { success: false, code, error: billingSetupErrorMessage(code), reload: code === 'version_conflict' || code === 'not_waiting' };
}

/** Only the documented keys travel; anything else (price, seats) never leaves the server. */
function contactPayload(c: BillingSetupContactInput): Record<string, string> {
  return c.who === 'me'
    ? { who: 'me', phone: c.phone ?? '' }
    : { who: 'other', name: c.name ?? '', email: c.email ?? '', phone: c.phone ?? '' };
}

function companyPayload(c: BillingSetupCompanyInput): Record<string, string> {
  const t = (v: string | undefined) => (v ?? '').trim();
  return {
    legal_name: t(c.legal_name),
    address_line1: t(c.address_line1),
    address_line2: t(c.address_line2),
    city: t(c.city),
    region: t(c.region),
    postal_code: t(c.postal_code),
    country: t(c.country).toUpperCase(),
    po_number: t(c.po_number),
  };
}

export async function completeBillingSetup(input: CompleteBillingSetupInput): Promise<BillingSetupResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { success: false, code: 'impersonation', error: blocked.error };
  if (!input.acceptTerms) return fail('terms_not_accepted');
  if (!Number.isInteger(input.expectedVersion)) return fail('version_conflict');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail('not_authenticated');
  const gate = await requireActiveOrgRole(supabase, user.id, input.organizationId, SETUP_ROLES);
  if (!gate.ok) return fail('not_authorized');

  const { data: accepted, error: acceptErr } = await supabase.rpc('broker_accept_terms', {
    p_org: input.organizationId,
    p_expected_version: input.expectedVersion,
    p_terms_version: TERMS_VERSION,
    p_terms_url: TERMS_URL,
  });
  if (acceptErr) return fail(acceptErr.code === '42501' ? 'not_authorized' : 'failed');
  if (!(accepted as RpcResult)?.success) return fail((accepted as RpcResult)?.error ?? 'failed');

  const { data: done, error: doneErr } = await supabase.rpc('broker_complete_billing_setup', {
    p_org: input.organizationId,
    p_expected_version: input.expectedVersion,
    p_contact: contactPayload(input.contact),
    p_company: companyPayload(input.company),
    p_billing_login: false,
  });
  if (doneErr) return fail(doneErr.code === '42501' ? 'not_authorized' : 'failed');
  const r = done as RpcResult;
  if (!r?.success || !r.billing_starts_on) return fail(r?.error ?? 'failed');

  revalidatePath('/dashboard', 'layout');
  return { success: true, billingStartsOn: r.billing_starts_on };
}

export async function askAboutPrice(organizationId: string): Promise<{ success: boolean; error?: string }> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { success: false, error: blocked.error };
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: billingSetupErrorMessage('not_authenticated') };
  const gate = await requireActiveOrgRole(supabase, user.id, organizationId, SETUP_ROLES);
  if (!gate.ok) return { success: false, error: billingSetupErrorMessage('not_authorized') };

  const service = createServiceClient();
  const { data: deal, error } = await service
    .from('org_deals')
    .select('stripe_mode, status')
    .eq('organization_id', organizationId)
    .maybeSingle();
  const d = deal as { stripe_mode?: 'test' | 'live'; status?: string } | null;
  if (error || !d?.stripe_mode || d.status !== 'draft') return { success: false, error: billingSetupErrorMessage('failed') };

  const day = new Date().toISOString().slice(0, 10);
  try {
    await enqueueOutbox(service, {
      mode: d.stripe_mode,
      kind: NOTIFY_ACCOUNT_MANAGER_KIND,
      organizationId,
      dedupeKey: `${NOTIFY_ACCOUNT_MANAGER_KIND}:${d.stripe_mode}:${organizationId}:price_question:${user.id}:${day}`,
      payload: {
        organization_id: organizationId,
        reason: 'price_question',
        stripe_object_id: null,
        detail: user.email ? `Asked by: ${user.email}` : null,
      },
      runAfter: new Date(),
    });
  } catch {
    return { success: false, error: billingSetupErrorMessage('failed') };
  }
  return { success: true };
}
