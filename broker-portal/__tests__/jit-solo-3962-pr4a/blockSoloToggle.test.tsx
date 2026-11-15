/**
 * BACKLOG-3962 PR4a T1 at the portal: the personal-accounts switch is offered on verified
 * domains only, shows the stored state, and asks the server to flip it.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockSet = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/actions/domainClaim', () => ({
  checkDomainClaim: jest.fn(),
  createDomainClaim: jest.fn(),
  withdrawDomainClaim: jest.fn(),
  setBlockSoloSignups: (...a: unknown[]) => mockSet(...a),
}));

import DomainSettingsClient from '@/app/dashboard/settings/domain/DomainSettingsClient';
import type { DomainClaimView } from '@/lib/domain/claims';

const mk = (over: Partial<DomainClaimView>): DomainClaimView => ({
  id: 'c1',
  domain: 'a.example',
  unicodeDomain: 'a.example',
  isInternationalized: false,
  status: 'verified',
  recordName: '_keepr.a.example',
  recordValue: 'keepr-domain-verification=' + 'a'.repeat(48),
  verifiedAt: '2026-11-10T12:00:00Z',
  lastCheckedAt: null,
  lastCheckResult: null,
  addedBy: null,
  blockSoloSignups: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSet.mockResolvedValue({ success: true, message: 'saved', status: 'verified' });
});

it('only verified domains get the switch', () => {
  render(
    <DomainSettingsClient
      loadState="ok"
      claims={[mk({ id: 'v1' }), mk({ id: 'p1', domain: 'p.example', unicodeDomain: 'p.example', status: 'pending' }), mk({ id: 'l1', domain: 'l.example', unicodeDomain: 'l.example', status: 'lapsed' })]}
    />
  );
  expect(screen.getByTestId('block-solo-v1')).toBeInTheDocument();
  expect(screen.queryByTestId('block-solo-p1')).not.toBeInTheDocument();
  expect(screen.queryByTestId('block-solo-l1')).not.toBeInTheDocument();
});

it('no verified domain: no section', () => {
  render(<DomainSettingsClient loadState="ok" claims={[mk({ id: 'p1', status: 'pending' })]} />);
  expect(screen.queryByText('Personal accounts')).not.toBeInTheDocument();
});

it.each([
  [false, 'Turn off personal accounts', true],
  [true, 'Allow personal accounts', false],
])('stored %s -> button "%s" sends %s', async (stored, label, sent) => {
  render(<DomainSettingsClient loadState="ok" claims={[mk({ id: 'v1', blockSoloSignups: stored })]} />);
  fireEvent.click(within(screen.getByTestId('block-solo-v1')).getByRole('button', { name: label }));
  await waitFor(() => expect(mockSet).toHaveBeenCalledWith('v1', sent));
  expect(await screen.findByText('saved')).toBeInTheDocument();
});
