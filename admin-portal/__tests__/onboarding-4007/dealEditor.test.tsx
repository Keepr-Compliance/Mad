// @vitest-environment jsdom
/**
 * BACKLOG-4007 PR-2: the deal form. A new or waiting deal gets a start-date picker (business
 * date or later) and no billing-contact fields; after setup the date is locked. The save always
 * calls the 10-arg admin_save_deal (p_start_date present, value or null).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OrgBilling } from '@/lib/billing/dealRules';
import { ACTIVE, NO_DEAL, WAITING } from './fixtures';

const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
// BACKLOG-3852: the save action reads admin_get_org_billing (business date) before saving; not counted in `calls`.
let serverBilling: OrgBilling | null = null;
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/supabase/server', () => ({
  getAuthenticatedUser: async () => ({
    user: { id: 'u1' },
    supabase: { rpc: async (fn: string, args: Record<string, unknown>) => { if (fn === 'admin_get_org_billing') return { data: serverBilling, error: null }; calls.push({ fn, args }); return { data: { success: true }, error: null }; } },
  }),
}));

// Far from any machine date: a picker that used new Date() instead of business_date fails here.
const FAR = '2030-01-01';

async function editor(billing: OrgBilling) {
  serverBilling = billing;
  const { DealEditor } = await import('@/app/dashboard/organizations/[id]/components/BrokerageBillingCard');
  const onSaved = vi.fn();
  render(<DealEditor organizationId="o1" organizationName="Org" planName="Team" billing={billing} onClose={() => {}} onSaved={onSaved} />);
  return onSaved;
}
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save deal' }));

beforeEach(() => { calls.length = 0; process.env.STRIPE_MODE = 'test'; });
afterEach(cleanup);

describe('new deal', () => {
  it('picker defaults to and is bounded by the business date; no contact fields', async () => {
    await editor({ ...NO_DEAL, business_date: FAR });
    const input = document.getElementById('deal-start-date') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe('date');
    expect(input.min).toBe(FAR);
    expect(input.value).toBe(FAR);
    expect(document.getElementById('deal-contact-email')).toBeNull();
    expect(document.getElementById('deal-contact-name')).toBeNull();
  });
  it('a date before the business date is refused and nothing is called', async () => {
    await editor({ ...NO_DEAL, business_date: FAR });
    fireEvent.change(document.getElementById('deal-start-date')!, { target: { value: '2029-12-31' } });
    save();
    expect(await screen.findByText('Pick today or a later start date.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
  it('a future date is sent as p_start_date, with no contact and the "Deal created" reason', async () => {
    const onSaved = await editor({ ...NO_DEAL, business_date: FAR });
    fireEvent.change(document.getElementById('deal-start-date')!, { target: { value: '2030-02-01' } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('admin_save_deal');
    expect(calls[0].args.p_start_date).toBe('2030-02-01');
    // BACKLOG-4007 People v2: the deal never carries the billing contact.
    expect(calls[0].args.p_billing_contact_email).toBeNull();
    expect(calls[0].args.p_billing_contact_name).toBeNull();
    expect(calls[0].args.p_reason).toBe('Deal created');
    expect(calls[0].args.p_expected_version).toBeNull();
  });
  it('today (the business date) is accepted', async () => {
    const onSaved = await editor({ ...NO_DEAL, business_date: FAR });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0].args.p_start_date).toBe(FAR);
  });
});

describe('waiting deal (draft)', () => {
  it('date stays editable, contact fields stay hidden, the date is sent', async () => {
    const onSaved = await editor(WAITING);
    expect((document.getElementById('deal-start-date') as HTMLInputElement).value).toBe('2026-10-24');
    expect(document.getElementById('deal-contact-email')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'more seats' } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(calls[0].args.p_start_date).toBe('2026-10-24');
    expect(calls[0].args.p_expected_version).toBe(1);
  });
});

describe('deal after setup (active)', () => {
  it('date is locked and sent as null (key still present); no contact fields (People v2: set in People)', async () => {
    const onSaved = await editor(ACTIVE);
    expect(document.getElementById('deal-start-date')).toBeNull();
    expect(screen.getByText('Locked after customer setup.')).toBeTruthy();
    expect(document.getElementById('deal-contact-email')).toBeNull();
    expect(document.getElementById('deal-contact-name')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'repriced' } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect('p_start_date' in calls[0].args).toBe(true);
    expect(calls[0].args.p_start_date).toBeNull();
    expect(calls[0].args.p_billing_contact_email).toBeNull();
  });
});
