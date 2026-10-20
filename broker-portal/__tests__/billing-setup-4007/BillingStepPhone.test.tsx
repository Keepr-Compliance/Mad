/** BACKLOG-4007: phone is formatted while typing, validated on blur, and gates Confirm. */
import { fireEvent, render, screen } from '@testing-library/react';
import { SETUP_VIEW_WAITING } from './fixtures';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));
jest.mock('@/lib/actions/billingSetup', () => ({ completeBillingSetup: jest.fn(), askAboutPrice: jest.fn() }));

import { BillingStep } from '@/components/setup/BillingStep';

const phoneEl = () => document.getElementById('bs-phone') as HTMLInputElement;
const type = (v: string) => fireEvent.change(phoneEl(), { target: { value: v } });
const confirm = () => screen.getByRole('button', { name: /confirm and finish/i }) as HTMLButtonElement;
const ERR = /enter a valid phone number/i;

function renderStep() {
  render(<BillingStep organizationId="ORG" view={SETUP_VIEW_WAITING} />);
  fireEvent.click(screen.getByRole('checkbox'));
}

describe('BillingStep phone', () => {
  it('formats while typing', () => {
    renderStep();
    type('2065550123');
    expect(phoneEl().value).toBe('(206) 555-0123');
  });

  it('typing does not show the error before blur; blur does', () => {
    renderStep();
    type('555');
    expect(screen.queryByText(ERR)).toBeNull();
    fireEvent.blur(phoneEl());
    expect(screen.getByText(ERR)).toBeTruthy();
  });

  it('the error clears as soon as the value becomes valid', () => {
    renderStep();
    type('555');
    fireEvent.blur(phoneEl());
    type('2065550123');
    expect(screen.queryByText(ERR)).toBeNull();
  });

  it('Confirm is disabled while the phone is invalid, enabled when valid (also in Someone else)', () => {
    renderStep();
    type('555');
    expect(confirm().disabled).toBe(true);
    type('2065550123');
    expect(confirm().disabled).toBe(false);
    fireEvent.click(screen.getByLabelText('Someone else'));
    expect(confirm().disabled).toBe(false);
    type('12345');
    expect(confirm().disabled).toBe(true);
  });

  it('a pasted +1 (206) 555-0123 is accepted', () => {
    renderStep();
    type('+1 (206) 555-0123');
    fireEvent.blur(phoneEl());
    expect(screen.queryByText(ERR)).toBeNull();
    expect(confirm().disabled).toBe(false);
  });

  it('empty on blur shows the error', () => {
    renderStep();
    fireEvent.blur(phoneEl());
    expect(screen.getByText(ERR)).toBeTruthy();
  });
});
