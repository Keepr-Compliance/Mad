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
    const btn = within(verifiedCell).getByRole('button', { name: 'Instructions for brokerage.com' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.hasAttribute('aria-controls')).toBe(false);
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
    const btn = screen.getByRole('button', { name: /^Instructions for / });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Instructions for brokerage.com');
    const panel = document.getElementById(btn.getAttribute('aria-controls') as string) as HTMLElement;
    expect(panel).toBeTruthy();
    expect(within(panel).getByLabelText('Host').textContent).toBe('_keepr');
    expect(within(panel).getByLabelText('Value').textContent).toBe(VALUE);
    expect(within(panel).getByText(/Last check:/)).toBeTruthy();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Host')).toBeNull();
  });

  const addDomain = async (value: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Domain'), { target: { value } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createDomainClaim).toHaveBeenCalledWith(value));
  };
  const c1 = mk({ id: 'c1', domain: 'old.example', unicodeDomain: 'old.example', recordName: '_keepr.old.example' });
  const c2 = mk({ id: 'c2', domain: 'new.example', unicodeDomain: 'new.example', recordName: '_keepr.new.example' });
  const expanded = (id: string) =>
    within(screen.getByTestId(`domain-claim-${id}`)).getByRole('button', { name: /^Instructions for / }).getAttribute('aria-expanded');

  it('a domain just added opens by the claim id the action returned', async () => {
    (createDomainClaim as jest.Mock).mockResolvedValue({ success: true, message: 'Added.', status: 'pending', claimId: 'c2', existing: false });
    const { rerender } = render(<DomainSettingsClient claims={[c1]} loadState="ok" />);
    await addDomain('new.example');
    rerender(<DomainSettingsClient claims={[c1, c2]} loadState="ok" />);
    await waitFor(() => expect(expanded('c2')).toBe('true'));
    expect(screen.getByLabelText('Host')).toBeTruthy();
    expect(expanded('c1')).toBe('false');
  });

  it('re-adding an already listed pending domain opens its row', async () => {
    (createDomainClaim as jest.Mock).mockResolvedValue({ success: true, message: 'Added.', status: 'pending', claimId: 'c1', existing: true });
    render(<DomainSettingsClient claims={[c1, c2]} loadState="ok" />);
    await addDomain('old.example');
    await waitFor(() => expect(expanded('c1')).toBe('true'));
    expect(expanded('c2')).toBe('false');
  });

  it('a later unrelated claim appearing does not open by itself', async () => {
    (createDomainClaim as jest.Mock).mockResolvedValue({ success: true, message: 'Added.', status: 'pending', claimId: 'c1', existing: true });
    const { rerender } = render(<DomainSettingsClient claims={[c1]} loadState="ok" />);
    await addDomain('old.example');
    await waitFor(() => expect(expanded('c1')).toBe('true'));
    rerender(<DomainSettingsClient claims={[c1, c2]} loadState="ok" />);
    expect(expanded('c2')).toBe('false');
    expect(screen.getAllByLabelText('Host')).toHaveLength(1);
  });

  it('Check on a collapsed row opens it and shows the result', async () => {
    (checkDomainClaim as jest.Mock).mockResolvedValue({ success: false, message: 'We could not find the record yet.' });
    render(<DomainSettingsClient claims={[mk({})]} loadState="ok" />);
    expect(screen.queryByText('We could not find the record yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('We could not find the record yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Instructions for / }).getAttribute('aria-expanded')).toBe('true');
  });

  it('a verified row keeps its date and has no Instructions button', () => {
    render(<DomainSettingsClient claims={[mk({ status: 'verified', verifiedAt: '2026-11-10T12:00:00Z' })]} loadState="ok" />);
    expect(screen.queryByRole('button', { name: /^Instructions for / })).toBeNull();
    const cell = within(screen.getByTestId('domain-claim-c1')).getAllByRole('cell')[2];
    expect(cell.textContent).toBe(new Date('2026-11-10T12:00:00Z').toLocaleDateString());
    expect(screen.getByRole('button', { name: 'Show DNS record' })).toBeTruthy();
  });

  it('a revoked row has no Instructions button', () => {
    render(<DomainSettingsClient claims={[mk({ status: 'revoked' })]} loadState="ok" />);
    expect(screen.queryByRole('button', { name: /^Instructions for / })).toBeNull();
  });
});
