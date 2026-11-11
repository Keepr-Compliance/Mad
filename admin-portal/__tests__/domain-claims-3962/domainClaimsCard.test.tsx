/**
 * BACKLOG-3962 PR2 — the Domains card on the organization page. Rendered to a string; the dialog
 * is closed. Rows are shaped like admin_list_domain_claims' jsonb_build_object (no token).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/actions/domainClaims', () => ({ revokeDomainClaimAction: vi.fn() }));

import { DomainClaimsCard } from '@/app/dashboard/organizations/[id]/components/DomainClaimsCard';
import type { AdminDomainClaim } from '@/lib/domainClaimRules';

const ORG = '00000000-0000-4000-8000-00000000000a'; // pii-allow-uuid: invented fixture id

function claim(id: string, domain: string, status: string, extra: Partial<AdminDomainClaim> = {}): AdminDomainClaim {
  return {
    id,
    domain,
    status,
    verified_at: status === 'verified' ? '2026-11-01T10:00:00Z' : null,
    last_checked_at: '2026-11-09T05:00:00Z',
    last_check_result: 'verified',
    consecutive_misses: 0,
    created_at: '2026-10-30T10:00:00Z',
    revoked_at: null,
    revoke_reason: null,
    ...extra,
  };
}

const CLAIMS = [
  claim('c1', 'verified.example', 'verified'),
  claim('c2', 'pending.example', 'pending'),
  claim('c3', 'lapsed.example', 'lapsed'),
  claim('c4', 'withdrawn.example', 'withdrawn'),
  claim('c5', 'revoked.example', 'revoked', { revoked_at: '2026-11-02T10:00:00Z', revoke_reason: 'support request' }),
];

const html = (p: Partial<Parameters<typeof DomainClaimsCard>[0]> = {}) =>
  renderToStaticMarkup(<DomainClaimsCard organizationId={ORG} claims={CLAIMS} canRevoke={false} {...p} />);
const count = (h: string, s: string) => h.split(s).length - 1;

describe('DomainClaimsCard', () => {
  it('a view-only staff member sees every claim and no Revoke', () => {
    const h = html({ canRevoke: false });
    expect(count(h, 'data-testid="domain-claim-row"')).toBe(5);
    expect(h).toContain('verified.example');
    expect(h).not.toContain('domain-claim-revoke');
    expect(h).not.toContain('>Revoke<');
  });

  it('an editor gets Revoke on pending, verified and lapsed claims only', () => {
    const h = html({ canRevoke: true });
    expect(count(h, 'data-testid="domain-claim-revoke"')).toBe(3);
  });

  it('shows the revoke reason on a revoked claim', () => {
    expect(html()).toContain('support request');
  });

  it('says so when the read failed, and offers no Revoke', () => {
    const h = html({ claims: [], failed: true, canRevoke: true });
    expect(h).toContain('load domains');
    expect(h).not.toContain('domain-claim-revoke');
  });

  it('empty list', () => {
    expect(html({ claims: [] })).toContain('No domains claimed.');
  });
});
