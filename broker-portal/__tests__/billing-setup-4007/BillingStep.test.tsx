/**
 * BACKLOG-4007 PR-3: the Billing step form. The order is read-only; Confirm sends the version shown
 * and never a price; it stays disabled until the Terms box is ticked. Fixture: ./fixtures.ts.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SETUP_VIEW_WAITING } from './fixtures';

const mockComplete = jest.fn();
const mockAsk = jest.fn();
const mockPush = jest.fn();
const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush, refresh: mockRefresh }) }));
jest.mock('@/lib/actions/billingSetup', () => ({
  completeBillingSetup: (...a: unknown[]) => mockComplete(...a),
  askAboutPrice: (...a: unknown[]) => mockAsk(...a),
}));

import { BillingStep } from '@/components/setup/BillingStep';

const ORG = 'ORG-4007-UI';

function fill() {
  const set = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });
  set('bs-legal', 'Realty LLC');
  set('bs-line1', '1 Main St');
  set('bs-city', 'Seattle');
  set('bs-region', 'WA');
  set('bs-postal', '98101');
  set('bs-phone', '2065550100');
}

beforeEach(() => jest.clearAllMocks());

describe('BillingStep', () => {
  it('shows the order staff set, read-only: seats, price per seat, monthly total, billing start', () => {
    render(<BillingStep organizationId={ORG} view={SETUP_VIEW_WAITING} />);
    expect(screen.getByText('Team')).toBeTruthy();
    expect(screen.getByText('$24.99 / month')).toBeTruthy();
    expect(screen.getByText('$124.95')).toBeTruthy();
    expect(screen.getByText('October 20, 2026')).toBeTruthy();
  });

  it('Confirm is disabled until the Terms box is ticked; then sends the version shown and no price', async () => {
    mockComplete.mockResolvedValue({ success: true, billingStartsOn: '2026-10-20' });
    render(<BillingStep organizationId={ORG} view={SETUP_VIEW_WAITING} />);
    fill();
    const confirm = screen.getByRole('button', { name: /confirm and finish/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(mockComplete).toHaveBeenCalledTimes(1));
    const arg = mockComplete.mock.calls[0][0];
    expect(arg).toMatchObject({
      organizationId: ORG,
      expectedVersion: SETUP_VIEW_WAITING.version,
      acceptTerms: true,
      contact: { who: 'me', phone: '(206) 555-0100' },
      company: { legal_name: 'Realty LLC', city: 'Seattle', region: 'WA', postal_code: '98101', country: 'US' },
    });
    expect(JSON.stringify(arg)).not.toMatch(/price|seats|total/i);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard/setup'));
  });

  it('a refusal shows its sentence; version_conflict reloads the page', async () => {
    mockComplete.mockResolvedValue({ success: false, code: 'version_conflict', error: 'Your Keepr account manager changed this order.', reload: true });
    render(<BillingStep organizationId={ORG} view={SETUP_VIEW_WAITING} />);
    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /confirm and finish/i }));
    await screen.findByText('Your Keepr account manager changed this order.');
    expect(mockRefresh).toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('"Question about this price?" asks the account manager; setup can continue', async () => {
    mockAsk.mockResolvedValue({ success: true });
    render(<BillingStep organizationId={ORG} view={SETUP_VIEW_WAITING} />);
    fireEvent.click(screen.getByRole('button', { name: /question about this price/i }));
    await screen.findByText(/will contact you/i);
    expect(mockAsk).toHaveBeenCalledWith(ORG);
    expect(screen.getByRole('button', { name: /confirm and finish/i })).toBeTruthy();
  });

  it('a new order version clears the Terms box and disables Confirm; the price-changed message stays', async () => {
    mockComplete.mockResolvedValue({ success: false, code: 'version_conflict', error: 'Your Keepr account manager changed this order.', reload: true });
    const { rerender } = render(<BillingStep organizationId={ORG} view={SETUP_VIEW_WAITING} />);
    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /confirm and finish/i }));
    await screen.findByText('Your Keepr account manager changed this order.');
    // router.refresh() re-renders the same component with the new order
    rerender(
      <BillingStep
        organizationId={ORG}
        view={{ ...SETUP_VIEW_WAITING, version: 2, unit_price_cents: 3999, monthly_total_cents: 19995 }}
      />
    );
    expect(screen.getByText('$39.99 / month')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: /confirm and finish/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Your Keepr account manager changed this order.')).toBeTruthy();
  });
});

// Founder QA: the body colour turns white under a dark OS preference (globals.css), so a label with no
// explicit colour of its own is unreadable on the white card.
describe('BillingStep radio labels', () => {
  it('"Who receives invoices" labels carry an explicit text-gray-900', () => {
    render(<BillingStep organizationId={ORG} view={SETUP_VIEW_WAITING} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio.closest('label')!.className).toContain('text-gray-900');
    }
  });
});

// Founder decision: "Billing starts" never shows a past date. broker_get_billing_setup returns
// billing_starts_on = greatest(business date, start_date) (migration 20261020100000, line ~698); the
// step shows that value and never start_date. The sentence explaining "whichever is later" is gone.
describe('BillingStep billing start date', () => {
  it('a start date in the past shows the business date (billing_starts_on), not start_date', () => {
    const view = { ...SETUP_VIEW_WAITING, start_date: '2026-10-05', billing_starts_on: '2026-10-20' };
    render(<BillingStep organizationId={ORG} view={view} />);
    expect(screen.getByText('October 20, 2026')).toBeTruthy();
    expect(screen.queryByText('October 5, 2026')).toBeNull();
  });

  it('a future start date shows that date', () => {
    const view = { ...SETUP_VIEW_WAITING, start_date: '2026-11-03', billing_starts_on: '2026-11-03' };
    render(<BillingStep organizationId={ORG} view={view} />);
    expect(screen.getByText('November 3, 2026')).toBeTruthy();
  });

  it('no longer says "whichever is later"; keeps the 15-day invoice line', () => {
    render(<BillingStep organizationId={ORG} view={SETUP_VIEW_WAITING} />);
    expect(screen.queryByText(/whichever is later/i)).toBeNull();
    expect(screen.getByText('Invoices are due in 15 days.')).toBeTruthy();
  });
});
