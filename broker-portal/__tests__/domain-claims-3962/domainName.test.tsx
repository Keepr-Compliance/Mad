/**
 * BACKLOG-3962 R10: an internationalised domain is shown with its A-label beside it, so a
 * look-alike name cannot pass for another. An ASCII domain is shown once.
 */

import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/actions/domainClaim', () => ({
  checkDomainClaim: jest.fn(),
  createDomainClaim: jest.fn(),
  withdrawDomainClaim: jest.fn(),
}));

import DomainSettingsClient, { DomainName } from '@/app/dashboard/settings/domain/DomainSettingsClient';
import type { DomainClaimView } from '@/lib/domain/claims';

const base: DomainClaimView = {
  id: 'c1',
  domain: 'xn--bcher-kva.example',
  unicodeDomain: 'bücher.example',
  isInternationalized: true,
  status: 'pending',
  recordName: '_keepr.xn--bcher-kva.example',
  recordValue: 'keepr-domain-verification=' + 'a'.repeat(48),
  verifiedAt: null,
  lastCheckedAt: null,
  lastCheckResult: null,
  addedBy: null,
};

describe('DomainName', () => {
  it('shows the Unicode form and the A-label when they differ', () => {
    render(<DomainName claim={base} />);
    expect(screen.getByText(/bücher\.example/)).toBeTruthy();
    expect(screen.getByText('(xn--bcher-kva.example)')).toBeTruthy();
  });

  it('shows an ASCII domain once', () => {
    const { container } = render(
      <DomainName claim={{ domain: 'brokerage.com', unicodeDomain: 'brokerage.com', isInternationalized: false }} />
    );
    expect(container.textContent).toBe('brokerage.com');
  });
});

describe('DomainSettingsClient', () => {
  it('a pending claim shows the record name and value to publish, and a Check button', () => {
    render(<DomainSettingsClient claims={[base]} loadState="ok" />);
    fireEvent.click(screen.getByRole('button', { name: 'Instructions' }));
    expect(screen.getByText('_keepr.xn--bcher-kva.example')).toBeTruthy();
    expect(screen.getByText(base.recordValue!)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
  });

  it('a revoked claim shows no record value and no Check button', () => {
    render(<DomainSettingsClient claims={[{ ...base, status: 'revoked', recordValue: null }]} loadState="ok" />);
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
    expect(screen.getByText('Revoked by Keepr support')).toBeTruthy();
  });

  it('the migration not applied yet shows the unavailable notice and disables Add', () => {
    render(<DomainSettingsClient claims={[]} loadState="unavailable" />);
    expect(screen.getByText("Domain verification isn't available yet.")).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add domain' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
