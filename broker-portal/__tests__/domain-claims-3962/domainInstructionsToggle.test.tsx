/**
 * BACKLOG-3962 QA follow-up: pending and lapsed rows keep their DNS instructions behind an
 * "Instructions" button in the Verified cell; Check and Remove stay in the Actions cell.
 */

import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/actions/domainClaim', () => ({
  checkDomainClaim: jest.fn(),
  createDomainClaim: jest.fn(),
  withdrawDomainClaim: jest.fn(),
}));

import DomainSettingsClient from '@/app/dashboard/settings/domain/DomainSettingsClient';
import { checkDomainClaim, createDomainClaim } from '@/lib/actions/domainClaim';
import type { DomainClaimView } from '@/lib/domain/claims';

const VALUE = 'keepr-domain-verification=' + 'a'.repeat(48);
const mk = (over: Partial<DomainClaimView>): DomainClaimView => ({
  id: 'c1',
  domain: 'brokerage.com',
  unicodeDomain: 'brokerage.com',
  isInternationalized: false,
  status: 'pending',
  recordName: '_keepr.brokerage.com',
  recordValue: VALUE,
  verifiedAt: null,
  lastCheckedAt: null,
  lastCheckResult: null,
  addedBy: null,
  ...over,
});

describe('Instructions toggle', () => {
  it.each(['pending', 'lapsed'] as const)('%s: button in the Verified cell, detail hidden by default', (status) => {
    render(<DomainSettingsClient claims={[mk({ status, lastCheckResult: 'not_found' })]} loadState="ok" />);
    const row = within(screen.getByTestId('domain-claim-c1'));
    const verifiedCell = row.getAllByRole('cell')[2];
    const btn = within(verifiedCell).getByRole('button', { name: 'Instructions' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/At your DNS host, add a TXT record/)).toBeNull();
    expect(screen.queryByLabelText('Host')).toBeNull();
    expect(screen.queryByText(/Last check:/)).toBeNull();
    // Check and Remove stay in the Actions cell while collapsed.
    const actions = row.getAllByRole('cell')[4];
    expect(within(actions).getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('clicking reveals Host, Value and the last check; clicking again hides them', () => {
    render(<DomainSettingsClient claims={[mk({ lastCheckResult: 'not_found' })]} loadState="ok" />);
    const btn = screen.getByRole('button', { name: 'Instructions' });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(btn.getAttribute('aria-controls') as string) as HTMLElement;
    expect(panel).toBeTruthy();
    expect(within(panel).getByLabelText('Host').textContent).toBe('_keepr');
    expect(within(panel).getByLabelText('Value').textContent).toBe(VALUE);
    expect(within(panel).getByText(/Last check:/)).toBeTruthy();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Host')).toBeNull();
  });

  it('a domain just added opens automatically once it appears in the list', async () => {
    (createDomainClaim as jest.Mock).mockResolvedValue({ success: true, message: 'Added.', status: 'pending' });
    const existing = mk({ id: 'c1', domain: 'old.example', unicodeDomain: 'old.example', recordName: '_keepr.old.example' });
    const { rerender } = render(<DomainSettingsClient claims={[existing]} loadState="ok" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Domain'), { target: { value: 'new.example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createDomainClaim).toHaveBeenCalledWith('new.example'));
    const added = mk({ id: 'c2', domain: 'new.example', unicodeDomain: 'new.example', recordName: '_keepr.new.example' });
    rerender(<DomainSettingsClient claims={[existing, added]} loadState="ok" />);
    const newBtn = within(screen.getByTestId('domain-claim-c2')).getByRole('button', { name: 'Instructions' });
    await waitFor(() => expect(newBtn.getAttribute('aria-expanded')).toBe('true'));
    expect(screen.getByLabelText('Host')).toBeTruthy();
    // The older row stays collapsed.
    const oldBtn = within(screen.getByTestId('domain-claim-c1')).getByRole('button', { name: 'Instructions' });
    expect(oldBtn.getAttribute('aria-expanded')).toBe('false');
  });

  it('Check on a collapsed row opens it and shows the result', async () => {
    (checkDomainClaim as jest.Mock).mockResolvedValue({ success: false, message: 'We could not find the record yet.' });
    render(<DomainSettingsClient claims={[mk({})]} loadState="ok" />);
    expect(screen.queryByText('We could not find the record yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('We could not find the record yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Instructions' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('a verified row keeps its date and has no Instructions button', () => {
    render(<DomainSettingsClient claims={[mk({ status: 'verified', verifiedAt: '2026-11-10T12:00:00Z' })]} loadState="ok" />);
    expect(screen.queryByRole('button', { name: 'Instructions' })).toBeNull();
    const cell = within(screen.getByTestId('domain-claim-c1')).getAllByRole('cell')[2];
    expect(cell.textContent).toBe(new Date('2026-11-10T12:00:00Z').toLocaleDateString());
    expect(screen.getByRole('button', { name: 'Show DNS record' })).toBeTruthy();
  });

  it('a revoked row has no Instructions button', () => {
    render(<DomainSettingsClient claims={[mk({ status: 'revoked' })]} loadState="ok" />);
    expect(screen.queryByRole('button', { name: 'Instructions' })).toBeNull();
  });
});
