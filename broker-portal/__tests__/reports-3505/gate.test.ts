/**
 * Broker Reports gate — BACKLOG-3505 (C2, fail-closed feature read, refusals).
 *
 * The REAL lib/reports/report-gate.ts and the REAL lib/feature-gate.ts run.
 * Mocked: the impersonation cookie, the portal classifier's result (the
 * PortalAccess shapes are the ones classifyPortalAccess emits, see
 * packages/shared/src/billing/planRule.ts) and the session client's rpc, so the
 * feature read's every failure mode is reachable.
 *
 * The registry is a TEST-ONLY fixture passed in, except where a test names the
 * shipped registry (BACKLOG-3513 PR-3a registers Submissions).
 *
 * @jest-environment node
 */

import { ORG_WITHOUT_PLAN_FEATURES, NOT_AUTHENTICATED_PAYLOAD, withFeature } from '../fixtures/orgFeatures';
import type { ReportDefinition } from '@/lib/reports/registry';

const mockImpersonation = jest.fn();
const mockPortal = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockImpersonation(),
}));
jest.mock('@/lib/auth/portalAccess', () => ({
  getPortalAccess: () => mockPortal(),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ rpc: mockRpc })),
}));
class NotFound extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}
jest.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound();
  },
}));

import {
  BROKER_REPORTS_FEATURE_KEY,
  listMyReports,
  requireMyReports,
  requireReportAccess,
} from '@/lib/reports/report-gate';

const ORG = '00000000-0000-4000-8000-000000350501'; // pii-allow-uuid: invented fixture id
const USER = '00000000-0000-4000-8000-000000350502'; // pii-allow-uuid: invented fixture id

const BROKER_ONLY: ReportDefinition = {
  slug: 'fixture-broker-only',
  title: 'Fixture broker report',
  description: 'Invented.',
  source: 'fixture_source',
  access: { roles: ['broker', 'admin', 'it_admin'], agentScoped: false },
};
const AGENT_SCOPED: ReportDefinition = {
  slug: 'fixture-agent-scoped',
  title: 'Fixture agent report',
  description: 'Invented.',
  source: 'fixture_source',
  access: { roles: ['broker', 'admin', 'it_admin'], agentScoped: true },
};
const REGISTRY = [BROKER_ONLY, AGENT_SCOPED] as const;

const FEATURE_ON = withFeature(ORG_WITHOUT_PLAN_FEATURES, BROKER_REPORTS_FEATURE_KEY, true, 'Reports');
const FEATURE_OFF = withFeature(ORG_WITHOUT_PLAN_FEATURES, BROKER_REPORTS_FEATURE_KEY, false, 'Reports');

type Access =
  | { kind: 'full'; role: string; organizationId: string }
  | { kind: 'floor'; via: 'brokerage' | 'personal_owner' | 'deactivated' | 'unlicensed'; role: string; organizationId: string }
  | { kind: 'unknown' }
  | { kind: 'none' };

const full = (role: string): Access => ({ kind: 'full', role, organizationId: ORG });
const floor = (via: 'brokerage' | 'personal_owner' | 'deactivated' | 'unlicensed', role = 'agent'): Access => ({
  kind: 'floor',
  via,
  role,
  organizationId: ORG,
});

function given(
  access: Access,
  opts: { suspended?: boolean | null; orgSuspended?: boolean | null; features?: unknown; rpcError?: boolean } = {}
): void {
  mockImpersonation.mockResolvedValue(null);
  mockPortal.mockResolvedValue({
    supabase: { rpc: mockRpc },
    user: { id: USER },
    access,
    suspended: opts.suspended === undefined ? false : opts.suspended,
    orgSuspended: opts.orgSuspended === undefined ? false : opts.orgSuspended,
    billingContact: false,
  });
  mockRpc.mockImplementation(async () =>
    opts.rpcError
      ? { data: null, error: { code: 'PGRST000', message: 'fixture: transport failure' } }
      : { data: 'features' in opts ? opts.features : FEATURE_ON, error: null }
  );
}

async function outcome(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof NotFound) return 'notFound';
    throw e;
  }
}
const grant = (slug: string) => outcome(async () => (await requireReportAccess(slug, REGISTRY)).scope);
const featureReads = () => mockRpc.mock.calls.filter(([name]) => name === 'broker_get_org_features').length;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('C2: role and scope per report', () => {
  it.each(['broker', 'admin', 'it_admin'])('%s opens both reports with scope all', async (role) => {
    given(full(role));
    expect(await grant(BROKER_ONLY.slug)).toBe('all');
    given(full(role));
    expect(await grant(AGENT_SCOPED.slug)).toBe('all');
  });

  it('a floor brokerage agent gets notFound on a broker-only report', async () => {
    given(floor('brokerage'));
    expect(await grant(BROKER_ONLY.slug)).toBe('notFound');
  });

  it('a floor brokerage agent opens an agent-scoped report with scope own (positive control)', async () => {
    given(floor('brokerage'));
    expect(await grant(AGENT_SCOPED.slug)).toBe('own');
  });

  it('a full role a report does not name is refused', async () => {
    given(full('it_admin'));
    const brokerOnlyRole: ReportDefinition = { ...BROKER_ONLY, slug: 'fixture-broker-role', access: { roles: ['broker'], agentScoped: false } };
    expect(await outcome(() => requireReportAccess(brokerOnlyRole.slug, [brokerOnlyRole]))).toBe('notFound');
  });

  it.each([
    ['unrecognised brokerage role (classifier floors it)', floor('brokerage', 'viewer')],
    ['personal-org owner', floor('personal_owner')],
    ['unlicensed brokerage member', floor('unlicensed')],
    ['deactivated brokerage member', floor('deactivated')],
    ['unknown access', { kind: 'unknown' } as Access],
    ['no portal access', { kind: 'none' } as Access],
  ])('%s is refused even an agent-scoped report, before any feature read', async (_n, access) => {
    given(access);
    expect(await grant(AGENT_SCOPED.slug)).toBe('notFound');
    expect(featureReads()).toBe(0);
  });

  it('an unknown slug is notFound, even for a broker', async () => {
    given(full('broker'));
    expect(await grant('no-such-report')).toBe('notFound');
  });
});

describe('refusals before the role', () => {
  it('impersonating: notFound, and the portal is never read', async () => {
    given(full('broker'));
    mockImpersonation.mockResolvedValue({ targetUserId: USER });
    expect(await grant(BROKER_ONLY.slug)).toBe('notFound');
    expect(mockPortal).not.toHaveBeenCalled();
  });

  it('not signed in: notFound', async () => {
    mockImpersonation.mockResolvedValue(null);
    mockPortal.mockResolvedValue(null);
    expect(await grant(BROKER_ONLY.slug)).toBe('notFound');
  });

  it.each([
    ['licence suspended', { suspended: true }],
    ['licence read failed', { suspended: null }],
    ['brokerage suspended', { orgSuspended: true }],
    ['brokerage read failed', { orgSuspended: null }],
  ] as const)('%s: notFound for a broker and an agent', async (_n, opts) => {
    given(full('broker'), opts);
    expect(await grant(BROKER_ONLY.slug)).toBe('notFound');
    given(floor('brokerage'), opts);
    expect(await grant(AGENT_SCOPED.slug)).toBe('notFound');
  });
});

describe('the plan feature is read fail-closed', () => {
  it.each([
    ['the feature RPC errors', { rpcError: true }],
    ['the RPC returns its own error payload', { features: NOT_AUTHENTICATED_PAYLOAD }],
    ['the payload is null', { features: null }],
    ['the key is absent', { features: ORG_WITHOUT_PLAN_FEATURES }],
    ['the key is disabled', { features: FEATURE_OFF }],
  ] as const)('%s: notFound', async (_n, opts) => {
    given(full('broker'), opts);
    expect(await grant(BROKER_ONLY.slug)).toBe('notFound');
    expect(featureReads()).toBe(1);
  });

  it('the key is enabled: admitted (positive control), read on the admitted organization', async () => {
    given(full('broker'));
    expect(await grant(BROKER_ONLY.slug)).toBe('all');
    expect(mockRpc).toHaveBeenCalledWith('broker_get_org_features', { p_org_id: ORG });
  });
});

describe('the index', () => {
  it('lists only the agent-scoped report to an agent, with scope own', async () => {
    given(floor('brokerage'));
    const mine = await listMyReports(REGISTRY);
    expect(mine?.reports.map((r) => [r.report.slug, r.scope])).toEqual([[AGENT_SCOPED.slug, 'own']]);
  });

  it('notFound when the caller has no report, even with the feature on', async () => {
    given(full('broker'));
    expect(await outcome(() => requireMyReports([]))).toBe('notFound');
    given(floor('brokerage'));
    expect(await outcome(() => requireMyReports([BROKER_ONLY]))).toBe('notFound');
  });

  // BACKLOG-3513 PR-3a registers the first report (Submissions, agent-scoped).
  it('the shipped registry lists Submissions: scope all for a broker, own for an agent', async () => {
    given(full('broker'));
    expect((await requireMyReports()).reports.map((r) => [r.report.slug, r.scope])).toEqual([['submissions', 'all']]);
    given(floor('brokerage'));
    expect((await requireMyReports()).reports.map((r) => [r.report.slug, r.scope])).toEqual([['submissions', 'own']]);
  });
});
