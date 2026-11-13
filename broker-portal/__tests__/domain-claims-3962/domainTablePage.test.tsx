/**
 * BACKLOG-3962 QA follow-up: the Domain page as a table, its add form, and the Settings card
 * that lists verified domains (rows filtered server-side by loadVerifiedDomains).
 */

import { render, screen, fireEvent, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/actions/domainClaim', () => ({
  checkDomainClaim: jest.fn(),
  createDomainClaim: jest.fn(),
  withdrawDomainClaim: jest.fn(),
}));
jest.mock('@/lib/actions/scim', () => ({
  getConsentStatus: async () => ({ organizationId: 'o', tenantId: null, consentGranted: false, consentGrantedAt: null }),
  getRetentionPolicy: async () => ({ retentionYears: 7 }),
  getJitStatus: async () => ({ enabled: false }),
  updateRetentionPolicy: async () => ({ success: true }),
  updateJitStatus: async () => ({ success: true }),
}));
jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: false }),
}));

import { createDomainClaim } from '@/lib/actions/domainClaim';
import DomainSettingsClient from '@/app/dashboard/settings/domain/DomainSettingsClient';
import OrgSettingsClient from '@/app/dashboard/settings/OrgSettingsClient';
import { loadVerifiedDomains, loadDomainClaims } from '@/lib/domain/claimView';
import type { DomainClaimView } from '@/lib/domain/claims';
import type { OrgSettingsFeatureView } from '@/lib/org-settings-access';

const mk = (over: Partial<DomainClaimView>): DomainClaimView => ({
  id: 'c1',
  domain: 'a.example',
  unicodeDomain: 'a.example',
  isInternationalized: false,
  status: 'pending',
  recordName: '_keepr.a.example',
  recordValue: 'keepr-domain-verification=' + 'a'.repeat(48),
  verifiedAt: null,
  lastCheckedAt: null,
  lastCheckResult: null,
  addedBy: null,
  blockSoloSignups: false,
  ...over,
});

describe('table', () => {
  it('renders one row per claim with status, verified date and added-by (name, email, dash)', () => {
    const claims = [
      mk({ id: 'c1', domain: 'a.example', unicodeDomain: 'a.example', status: 'verified', verifiedAt: '2026-11-10T12:00:00Z', addedBy: 'display-name-a' }),
      mk({ id: 'c2', domain: 'b.example', unicodeDomain: 'b.example', status: 'pending', addedBy: 'dana@a.example' }),
      mk({ id: 'c3', domain: 'c.example', unicodeDomain: 'c.example', status: 'lapsed', addedBy: null }),
    ];
    render(<DomainSettingsClient claims={claims} loadState="ok" />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Domain', 'Status', 'Verified', 'Added by', 'Actions',
    ]);
    const r1 = within(screen.getByTestId('domain-claim-c1')).getAllByRole('cell').map((c) => c.textContent);
    expect(r1.slice(0, 4)).toEqual(['a.example', 'Verified', new Date('2026-11-10T12:00:00Z').toLocaleDateString(), 'display-name-a']);
    const r2 = within(screen.getByTestId('domain-claim-c2')).getAllByRole('cell').map((c) => c.textContent);
    expect(r2.slice(0, 4)).toEqual(['b.example', 'Not verified yet', 'Instructions', 'dana@a.example']);
    const r3 = within(screen.getByTestId('domain-claim-c3')).getAllByRole('cell').map((c) => c.textContent);
    expect(r3.slice(0, 4)).toEqual(['c.example', 'Verification lapsed', 'Instructions', '—']);
  });

  it('the header Add domain button opens the add form', () => {
    render(<DomainSettingsClient claims={[mk({})]} loadState="ok" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    expect(within(screen.getByRole('dialog')).getByLabelText('Domain')).toBeTruthy();
  });
});

describe('add dialog', () => {
  it('a failed add shows its error inside the dialog, not only on the page', async () => {
    (createDomainClaim as jest.Mock).mockResolvedValue({ success: false, message: 'That domain is already verified by another brokerage.' });
    render(<DomainSettingsClient claims={[]} loadState="ok" />);
    fireEvent.click(screen.getByRole('button', { name: 'Add domain' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe('add-domain-title');
    expect(document.getElementById('add-domain-title')?.textContent).toBe('Add a domain');
    fireEvent.change(within(dialog).getByLabelText('Domain'), { target: { value: 'taken.example' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(alert.textContent).toBe('That domain is already verified by another brokerage.');
  });
});

describe('empty state', () => {
  it('shows the line and its button opens the same add form', () => {
    render(<DomainSettingsClient claims={[]} loadState="ok" />);
    expect(screen.getByText('No domains yet')).toBeTruthy();
    expect(screen.getByText("Add your brokerage's email domain to verify it.")).toBeTruthy();
    expect(screen.queryByText(/No domains yet\. /)).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '+ Add domain' }));
    expect(within(screen.getByRole('dialog')).getByLabelText('Domain')).toBeTruthy();
  });
});

// A query builder that applies .eq() filters to rows, as PostgREST does.
function fakeClient(rows: Array<Record<string, unknown>>) {
  return {
    from: (_t: string) => {
      const eqs: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => (eqs.push([c, v]), b),
        in: () => b,
        order: async () => ({ data: rows.filter((r) => eqs.every(([c, v]) => r[c] === v)), error: null }),
      };
      return b;
    },
  } as never;
}

const ROWS = [
  { organization_id: 'o1', domain: 'verified-one.example', status: 'verified' },
  { organization_id: 'o1', domain: 'pending-one.example', status: 'pending' },
  { organization_id: 'o1', domain: 'lapsed-one.example', status: 'lapsed' },
  { organization_id: 'o2', domain: 'other-org.example', status: 'verified' },
];

describe('loadVerifiedDomains', () => {
  it('returns only this organization\'s verified domains', async () => {
    expect(await loadVerifiedDomains(fakeClient(ROWS), 'o1')).toEqual(['verified-one.example']);
  });
  it('never throws', async () => {
    const boom = { from: () => { throw new Error('x'); } } as never;
    expect(await loadVerifiedDomains(boom, 'o1')).toEqual([]);
  });
});

describe('loadDomainClaims added-by', () => {
  it('uses the display name, else the email, else null', async () => {
    const claimRows = [
      { id: '1', domain: 'a.example', token: 't', status: 'pending', verified_at: null, last_checked_at: null, last_check_result: null, created_by: 'u1' },
      { id: '2', domain: 'b.example', token: 't', status: 'pending', verified_at: null, last_checked_at: null, last_check_result: null, created_by: 'u2' },
      { id: '3', domain: 'c.example', token: 't', status: 'pending', verified_at: null, last_checked_at: null, last_check_result: null, created_by: 'gone' },
    ];
    // organization_members rows as the select returns them. The o2 row (same user id, a different
    // name) comes LAST: without the organization_id filter it would overwrite o1's name.
    const members = [
      { organization_id: 'o1', user_id: 'u1', user: { email: 'u1@x.example', first_name: 'x', last_name: 'y', display_name: 'display-name-b' } },
      { organization_id: 'o1', user_id: 'u2', user: { email: 'u2@x.example', first_name: null, last_name: null, display_name: null } },
      { organization_id: 'o2', user_id: 'u1', user: { email: 'u1@other.example', first_name: null, last_name: null, display_name: 'other-org-name' } },
    ];
    const client = {
      from: (t: string) => {
        const eqs: Array<[string, unknown]> = [];
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (c: string, v: unknown) => (eqs.push([c, v]), b),
          in: (c: string, vs: unknown[]) =>
            t === 'organization_members'
              ? Promise.resolve({
                  data: members.filter((m) => eqs.every(([ec, ev]) => (m as Record<string, unknown>)[ec] === ev) && vs.includes((m as Record<string, unknown>)[c])),
                  error: null,
                })
              : b,
          order: async () => ({ data: claimRows, error: null }),
        };
        return b;
      },
    } as never;
    const res = await loadDomainClaims(client, 'o1');
    expect(res.ok && res.claims.map((c) => c.addedBy)).toEqual(['display-name-b', 'u2@x.example', null]);
  });
});

describe('Settings card', () => {
  const VIEW: OrgSettingsFeatureView = {
    retention: { policy: 'hidden', unlockLabel: null },
    scim: { policy: 'hidden', unlockLabel: null },
    jit: { policy: 'hidden', unlockLabel: null },
  };

  it('lists a verified domain', async () => {
    render(<OrgSettingsClient features={VIEW} verifiedDomains={['a.example']} />);
    expect((await screen.findByTestId('verified-domains')).textContent).toBe('Verified: a.example');
  });
  it('caps at 3', async () => {
    render(<OrgSettingsClient features={VIEW} verifiedDomains={['a.x', 'b.x', 'c.x', 'd.x', 'e.x']} />);
    expect((await screen.findByTestId('verified-domains')).textContent).toBe('Verified: a.x, b.x, c.x +2 more');
  });
  it('shows nothing extra when there are none', async () => {
    render(<OrgSettingsClient features={VIEW} verifiedDomains={[]} />);
    await screen.findByText('Domain Verification');
    expect(screen.queryByTestId('verified-domains')).toBeNull();
  });
  it('end to end: the page data excludes pending and lapsed domains', async () => {
    const verified = await loadVerifiedDomains(fakeClient(ROWS), 'o1');
    render(<OrgSettingsClient features={VIEW} verifiedDomains={verified} />);
    const text = (await screen.findByTestId('verified-domains')).textContent;
    expect(text).toBe('Verified: verified-one.example');
    expect(text).not.toMatch(/pending|lapsed|other-org/);
  });
});
