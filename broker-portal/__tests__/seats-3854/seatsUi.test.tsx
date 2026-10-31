/**
 * BACKLOG-3854: the Seats block, the Manage billing block and the organization block list.
 *
 * The broker_get_seats payload is transcribed from keepr-test (QA Brokerage 1, its Admin's
 * session, 2026-10-21): {"free":2,"bought":3,"in_use":1,"can_add":true,"version":2,
 * "trialing":true,"unlimited":false,"unit_price_cents":2499,"cannot_add_reason":null,
 * "account_manager_email":null}. Variants mark the edited fields [EDITED].
 */

import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockAddSeats = jest.fn();
const mockRpc = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/actions/seats', () => ({ addSeats: (...a: unknown[]) => mockAddSeats(...a) }));
jest.mock('@/lib/actions/billingPortal', () => ({ openBrokerageBillingPortal: jest.fn() }));
jest.mock('next/cache', () => ({ revalidatePath: jest.fn() }));
jest.mock('@/lib/actions/agentPlan', () => ({}));
jest.mock('@/lib/actions/billingCard', () => ({}));
jest.mock('@/lib/actions/autoRenew', () => ({ setAutoRenew: jest.fn() }));

import { SeatsBlock, cannotAddLine, addSeatsLine, type SeatsViewer } from '@/components/billing/SeatsBlock';
import { BillingPage } from '@/components/billing/BillingPage';
import { readSeats, type SeatsView } from '@/lib/billing/seats';
import { billingCapabilities } from '@/lib/billing/capabilities';

const ORG = '00000000-0000-0000-0000-000000000000';
const KT_PAYLOAD = {
  free: 2,
  bought: 3,
  in_use: 1,
  can_add: true,
  version: 2,
  trialing: true,
  unlimited: false,
  unit_price_cents: 2499,
  cannot_add_reason: null,
  account_manager_email: null,
};

async function view(over: Record<string, unknown> = {}): Promise<SeatsView> {
  mockRpc.mockResolvedValueOnce({ data: { ...KT_PAYLOAD, ...over }, error: null });
  const v = await readSeats({ rpc: mockRpc } as never, ORG);
  if (!v) throw new Error('test: read failed');
  return v;
}

beforeEach(() => {
  mockAddSeats.mockReset();
  mockRpc.mockReset();
});

describe('readSeats', () => {
  it('maps the database payload; a failed read is null', async () => {
    expect(await view()).toEqual({
      bought: 3, inUse: 1, free: 2, unlimited: false, canAdd: true, reason: null, version: 2,
      unitPriceCents: 2499, trialing: true, accountManagerEmail: null,
    });
    expect(mockRpc).toHaveBeenCalledWith('broker_get_seats', { p_org: ORG });
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    expect(await readSeats({ rpc: mockRpc } as never, ORG)).toBeNull();
  });
});

describe('SeatsBlock', () => {
  it('counts; Add seats -> modal (trial copy promises no charge) -> addSeats(count to ADD, read version)', async () => {
    mockAddSeats.mockResolvedValue({ ok: true, error: null, seatsTo: 5 });
    const { container } = render(<SeatsBlock view={await view()} viewer="admin" />);
    expect(container.querySelector('[data-seats-counts]')?.textContent).toBe('Seats3In use1Available2');
    fireEvent.click(screen.getByRole('button', { name: 'Add seats' }));
    fireEvent.change(screen.getByLabelText('Seats to add'), { target: { value: '2' } });
    expect(screen.getByText('You have 3 seats. After this: 5. The new seats are billed from the end of your trial.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockAddSeats).toHaveBeenCalledWith(2, 2));
  });

  it('outside a trial the line says prorated, with the price [EDITED trialing=false]', async () => {
    const v = await view({ trialing: false });
    expect(addSeatsLine(v, 1)).toBe(
      'You have 3 seats. After this: 4. A prorated charge for the rest of this period appears on your next invoice ($24.99 per seat per month).'
    );
  });

  it('an invalid count disables Confirm and calls nothing', async () => {
    render(<SeatsBlock view={await view()} viewer="broker" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add seats' }));
    fireEvent.change(screen.getByLabelText('Seats to add'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('an action error is shown in the modal', async () => {
    mockAddSeats.mockResolvedValue({ ok: false, error: 'Pay the overdue invoice to add seats.' });
    render(<SeatsBlock view={await view()} viewer="admin" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add seats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Pay the overdue invoice to add seats.')).toBeInTheDocument();
  });

  it('no button when the database says can_add false, whatever the role [EDITED can_add]', async () => {
    for (const viewer of ['broker', 'admin', 'it_admin', 'billing_contact'] as SeatsViewer[]) {
      const { unmount } = render(<SeatsBlock view={await view({ can_add: false, cannot_add_reason: 'not_allowed', version: null })} viewer={viewer} />);
      expect(screen.queryByRole('button', { name: 'Add seats' })).toBeNull();
      unmount();
    }
  });

  it('SR change 5: canceling copy by role [EDITED can_add, cannot_add_reason]', async () => {
    const v = await view({ can_add: false, cannot_add_reason: 'deal_canceling', version: null });
    expect(cannotAddLine(v, 'broker')).toBe('Your plan is ending. An Admin can turn auto-renew back on.');
    expect(cannotAddLine(v, 'admin')).toBe('Your plan is ending. Turn auto-renew back on to add seats.');
    expect(cannotAddLine(v, 'it_admin')).toBe('Ask a Broker or Admin to add seats.');
  });

  it('overdue -> pay first; suspended -> no line (the banner says it)', async () => {
    expect(cannotAddLine(await view({ can_add: false, cannot_add_reason: 'invoice_overdue' }), 'broker')).toBe('Pay the overdue invoice to add seats.');
    expect(cannotAddLine(await view({ can_add: false, cannot_add_reason: 'deal_suspended' }), 'admin')).toBeNull();
  });

  it('IT admin: counts, the ask line, no "Fewer seats" line and no price anywhere', async () => {
    const { container } = render(
      <SeatsBlock view={await view({ can_add: false, cannot_add_reason: 'not_allowed', version: null, unit_price_cents: null })} viewer="it_admin" />
    );
    expect(screen.getByText('Ask a Broker or Admin to add seats.')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Fewer seats|\$/);
  });

  it('Fewer seats -> the account manager, else sales@', async () => {
    render(<SeatsBlock view={await view({ account_manager_email: 'am-3854@example.test' })} viewer="admin" />);
    expect(screen.getByText('Fewer seats? Email am-3854@example.test.')).toBeInTheDocument();
  });

  it('limited -> the unused-seat count is labelled "Available", not "Free" (BACKLOG-4027)', async () => {
    render(<SeatsBlock view={await view({})} viewer="admin" />);
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.queryByText('Free')).toBeNull();
  });

  it('unlimited -> "No seat limit", no Available', async () => {
    render(<SeatsBlock view={await view({ unlimited: true, bought: null, free: null })} viewer="admin" />);
    expect(screen.getByText('No seat limit')).toBeInTheDocument();
    expect(screen.queryByText('Available')).toBeNull();
  });

  it('a failed read -> one line, no button', () => {
    render(<SeatsBlock view={null} viewer="admin" />);
    expect(screen.getByText('Seat counts are unavailable right now.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('organization blocks (SB) and Manage billing', () => {
  const full = (role: string) => ({ kind: 'full' as const, role, organizationId: ORG });
  const caps = (role: string, over: Record<string, unknown> = {}) =>
    billingCapabilities({
      access: full(role) as never,
      isImpersonating: false,
      enabled: true,
      agentPlan: 'none',
      accountSuspended: false,
      orgBillingSetUp: true,
      ...over,
    })!;

  it('set up: plan, seats, manage_billing for Broker/Admin; never payment or invoices frames; IT admin has no money block', () => {
    expect(caps('broker').blocks).toEqual(['plan', 'seats', 'manage_billing']);
    expect(caps('admin').blocks).toEqual(['plan', 'seats', 'manage_billing']);
    expect(caps('it_admin').blocks).toEqual(['plan', 'seats']);
    expect(caps('admin', { orgBillingSetUp: false }).blocks).toEqual(['plan', 'seats']);
  });

  it('suspended: Manage billing still shows for Broker/Admin under the banner, not for IT admin', async () => {
    const v = await view({ can_add: false, cannot_add_reason: 'deal_suspended', version: null });
    for (const [role, shows] of [['broker', true], ['admin', true], ['it_admin', false]] as [string, boolean][]) {
      const { unmount } = render(
        <BillingPage
          caps={caps(role, { orgSuspended: true })}
          orgBillingSetUp
          orgSuspension={{ reason: 'non_payment', role, organizationName: 'P3854', payUrl: null }}
          seats={{ view: v, viewer: role as SeatsViewer }}
        />
      );
      expect(screen.queryAllByRole('button', { name: 'Manage billing ↗' }).length > 0).toBe(shows);
      expect(document.querySelector('[data-billing-block="payment"], [data-billing-block="invoices"]')).toBeNull();
      unmount();
    }
  });

  it('?portal=unavailable -> one error line in the block', async () => {
    render(<BillingPage caps={caps('admin')} orgBillingSetUp seats={{ view: await view(), viewer: 'admin' }} portalUnavailable />);
    expect(screen.getByText('Stripe is unavailable right now. Try again in a minute.')).toBeInTheDocument();
  });

  it('no Stripe ids in the rendered page', async () => {
    const { container } = render(<BillingPage caps={caps('admin')} orgBillingSetUp seats={{ view: await view(), viewer: 'admin' }} />);
    expect(container.innerHTML).not.toMatch(/\b(in|cus|sub|bps|bpc|pi|ch)_[A-Za-z0-9]{6,}/);
  });
});
