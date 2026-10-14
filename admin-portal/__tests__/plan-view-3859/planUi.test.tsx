/**
 * BACKLOG-3859 — the Plan column cell, the Plan card and the Account card.
 * Static renders.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/admin-queries', () => ({ updateLicense: vi.fn(), getUserDisplayName: () => 'x' }));
vi.mock('@/components/pwa/NavigationProgress', () => ({ startNavigationProgress: vi.fn() }));

import { PlanCell } from '@/app/dashboard/users/components/UserResultsTable';
import { PlanCard } from '@/app/dashboard/users/[id]/components/PlanCard';
import { LicenseCard } from '@/app/dashboard/users/[id]/components/LicenseCard';

const U = 'u-1';
const LINE = { kind: 'agent_unlimited' as const, text: 'Agent Unlimited, paid by Stripe', test: true, warning: null };

describe('PlanCell', () => {
  it('loading and idle show a dash; error shows Plan unavailable', () => {
    expect(renderToStaticMarkup(<PlanCell userId={U} state={{ status: 'loading' }} />)).toContain('—');
    expect(renderToStaticMarkup(<PlanCell userId={U} state={undefined} />)).toContain('—');
    expect(renderToStaticMarkup(<PlanCell userId={U} state={{ status: 'error' }} />)).toContain('Plan unavailable');
  });

  it('ready shows the line and a TEST tag', () => {
    const html = renderToStaticMarkup(<PlanCell userId={U} state={{ status: 'ready', lines: { [U]: LINE } }} />);
    expect(html).toContain('Agent Unlimited, paid by Stripe');
    expect(html).toContain('TEST');
  });
});

describe('PlanCard', () => {
  it('line, TEST tag and warning; no currency sign', () => {
    const html = renderToStaticMarkup(
      <PlanCard line={{ ...LINE, kind: 'pay_as_you_go', text: 'Solo Pay as you go, 3 credits', warning: 'Unlimited is on, but no open subscription was found' }} />
    );
    expect(html).toContain('Solo Pay as you go, 3 credits');
    expect(html).toContain('Unlimited is on, but no open subscription was found');
    expect(html).not.toMatch(/[$€£]/);
  });

  it('null line -> Plan unavailable', () => {
    expect(renderToStaticMarkup(<PlanCard line={null} />)).toContain('Plan unavailable');
  });
});

describe('Account card (LicenseCard)', () => {
  // Shape of the flagged test org agent's licenses row (status active, max_devices 2,
  // license_type individual); id, key and dates invented.
  const lic = {
    id: 'lic-1',
    license_type: 'individual',
    license_key: 'KEY-FX',
    status: 'active',
    max_devices: 2,
    expires_at: '2027-01-01T00:00:00+00:00',
    created_at: '2026-10-10T16:28:23+00:00',
  };

  it('shows account status and device limit; not license type, trial or expiry', () => {
    const html = renderToStaticMarkup(<LicenseCard licenses={[lic]} />);
    expect(html).toContain('Account');
    expect(html).toContain('active');
    expect(html).toContain('Device limit: 2');
    expect(html).not.toMatch(/Trial/);
    expect(html).not.toMatch(/Expires:/);
    expect(html).not.toMatch(/Transactions:/);
    // license_type appears only inside the Edit dialog's form, not as the row title.
    expect(html).not.toMatch(/<p class="text-sm font-medium text-gray-900 capitalize">individual<\/p>/);
  });
});
