/**
 * BACKLOG-3962 QA follow-up: Host/Value instructions, verified-claim layout, back link.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/actions/domainClaim', () => ({
  checkDomainClaim: jest.fn(),
  createDomainClaim: jest.fn(),
  withdrawDomainClaim: jest.fn(),
}));

import DomainSettingsClient, { hostLabel } from '@/app/dashboard/settings/domain/DomainSettingsClient';
import { checkDomainClaim, withdrawDomainClaim } from '@/lib/actions/domainClaim';
import type { DomainClaimView } from '@/lib/domain/claims';

const VALUE = 'keepr-domain-verification=' + 'a'.repeat(48);
const pending: DomainClaimView = {
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
};
const verified: DomainClaimView = { ...pending, status: 'verified', verifiedAt: '2026-11-10T00:00:00Z' };

describe('instructions', () => {
  it.each(['pending', 'lapsed'] as const)('%s: Host is the relative label, with the full-name fallback', (status) => {
    render(<DomainSettingsClient claims={[{ ...pending, status }]} loadState="ok" />);
    fireEvent.click(screen.getByRole('button', { name: /^Instructions for / }));
    expect(screen.getByText('At your DNS host, add a TXT record. Leave your other records as they are.')).toBeTruthy();
    expect(screen.getByLabelText('Host').textContent).toBe('_keepr');
    expect(screen.getByLabelText('Value').textContent).toBe(VALUE);
    expect(screen.queryByText('Name')).toBeNull();
    const helper = screen.getByText(/Most DNS hosts add your domain to the end of the Host for you/);
    expect(helper.textContent).toBe(
      'Most DNS hosts add your domain to the end of the Host for you. If yours asks for the full name, use _keepr.brokerage.com.'
    );
    expect(helper.querySelector('code')?.textContent).toBe('_keepr.brokerage.com');
  });

  it('hostLabel falls back to the full name when it is not under the domain', () => {
    expect(hostLabel('_keepr.brokerage.com', 'brokerage.com')).toBe('_keepr');
    expect(hostLabel('_keepr.other.com', 'brokerage.com')).toBe('_keepr.other.com');
    expect(hostLabel('.brokerage.com', 'brokerage.com')).toBe('.brokerage.com');
  });
});

describe('verified claim', () => {
  it('shows Show DNS record and Remove; no note or record until opened', () => {
    render(<DomainSettingsClient claims={[verified]} loadState="ok" />);
    expect(screen.getByRole('button', { name: 'Show DNS record' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    expect(screen.queryByText(/Keep the record in place/)).toBeNull();
    expect(screen.queryByLabelText('Host')).toBeNull();
    expect(screen.queryByText(VALUE)).toBeNull();
  });

  it('clicking Show DNS record shows the note and record; label becomes Hide DNS record', () => {
    render(<DomainSettingsClient claims={[verified]} loadState="ok" />);
    const toggle = screen.getByRole('button', { name: 'Show DNS record' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide DNS record');
    expect(toggle.getAttribute('aria-controls')).toBe('domain-instructions-c1');
    expect(document.getElementById('domain-instructions-c1')).toBeTruthy();
    expect(screen.getByText('Keep the record in place: Keepr checks it again every day.')).toBeTruthy();
    expect(screen.getByLabelText('Host').textContent).toBe('_keepr');
    expect(screen.getByLabelText('Value').textContent).toBe(VALUE);
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('Host')).toBeNull();
  });

  it('Hide closes a just-verified row even while its notice is showing', async () => {
    (checkDomainClaim as jest.Mock).mockResolvedValue({ success: true, message: 'Domain verified.' });
    const { rerender } = render(<DomainSettingsClient claims={[pending]} loadState="ok" />);
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(await screen.findByText('Domain verified.')).toBeTruthy();
    rerender(<DomainSettingsClient claims={[verified]} loadState="ok" />);
    const toggle = screen.getByRole('button', { name: 'Hide DNS record' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Host')).toBeTruthy();
    expect(screen.getByText('Domain verified.')).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    expect(toggle.textContent).toBe('Show DNS record');
    expect(screen.queryByLabelText('Host')).toBeNull();
    expect(screen.queryByText('Domain verified.')).toBeNull();
  });

  it('Remove is still two-step', () => {
    (withdrawDomainClaim as jest.Mock).mockResolvedValue({ success: true, message: 'Domain removed.' });
    render(<DomainSettingsClient claims={[verified]} loadState="ok" />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(withdrawDomainClaim).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
    expect(withdrawDomainClaim).toHaveBeenCalledWith('c1');
  });

  it('a pending claim keeps Instructions, Check and Remove', () => {
    render(<DomainSettingsClient claims={[pending]} loadState="ok" />);
    expect(screen.getByRole('button', { name: /^Instructions for / })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show DNS record' })).toBeNull();
  });
});

describe('back link', () => {
  it('goes to Settings', () => {
    render(<DomainSettingsClient claims={[]} loadState="ok" />);
    expect(screen.getByRole('link', { name: /Back to Settings/ }).getAttribute('href')).toBe('/dashboard/settings');
  });
});
