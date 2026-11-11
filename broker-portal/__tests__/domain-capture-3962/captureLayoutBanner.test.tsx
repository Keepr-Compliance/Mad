/**
 * BACKLOG-3962 PR3b: the dashboard layout reads the caller's scheduled move and renders the banner
 * only for a personal owner, never while impersonating, never for a brokerage user.
 */
import React from 'react';

const mockPortal = jest.fn();
const mockImpersonation = jest.fn();
const mockNotice = jest.fn();

jest.mock('next/navigation', () => ({ redirect: () => { throw new Error('NEXT_REDIRECT'); } }));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: () => mockImpersonation() }));
jest.mock('@/lib/auth/portalAccess', () => ({ getPortalAccess: () => mockPortal() }));
jest.mock('@/lib/checklist-access', () => ({ CHECKLIST_FEATURE_KEY: 'checklists', isChecklistPageEnabled: async () => false }));
jest.mock('@/lib/checklist-nav', () => ({ getChecklistNavPolicy: async () => 'hidden' }));
jest.mock('@/lib/my-transactions-access', () => ({ getMyTransactionsGate: async () => null }));
jest.mock('@/lib/reports/report-gate', () => ({ listMyReports: async () => null }));
jest.mock('@/lib/billing/flag', () => ({ billingEnabled: () => false }));
jest.mock('@/lib/billing/capabilities', () => ({ billingNavVisible: () => false }));
jest.mock('@/lib/domain/captureView', () => ({ loadCaptureNotice: (...a: unknown[]) => mockNotice(...a) }));

import DashboardLayout from '@/app/dashboard/layout';
import CaptureNoticeBanner from '@/components/CaptureNoticeBanner';

const NOTICE = { switchId: 's-me', brokerageName: 'A Brokerage', domain: 'a-brokerage.example', switchAt: '2026-11-24T10:00:00Z' };
const client = { rpc: jest.fn() };
const user = { id: 'u1', email: 'me@a-brokerage.example' };

function findBanner(node: unknown): React.ReactElement | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const f = findBanner(n); if (f) return f; }
    return null;
  }
  const el = node as React.ReactElement<{ children?: unknown }>;
  if (el.type === CaptureNoticeBanner) return el;
  return findBanner(el.props?.children);
}

async function render() {
  const element = (await DashboardLayout({ children: <div /> })) as React.ReactElement<{ children?: unknown }>;
  return findBanner(element.props.children);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockImpersonation.mockResolvedValue(null);
  mockNotice.mockResolvedValue(NOTICE);
});

it('personal owner with a scheduled move: banner, read on the session client', async () => {
  mockPortal.mockResolvedValue({ access: { kind: 'floor', via: 'personal_owner', role: 'agent' }, user, supabase: client });
  const banner = await render();
  expect(banner?.props).toEqual({ notice: NOTICE });
  expect(mockNotice).toHaveBeenCalledWith(client);
});

it('personal owner without a scheduled move: no banner', async () => {
  mockPortal.mockResolvedValue({ access: { kind: 'floor', via: 'personal_owner', role: 'agent' }, user, supabase: client });
  mockNotice.mockResolvedValue(null);
  expect(await render()).toBeNull();
});

it('brokerage user (full access): no banner, nothing read', async () => {
  mockPortal.mockResolvedValue({ access: { kind: 'full', role: 'admin', organizationId: 'org' }, user, supabase: client });
  expect(await render()).toBeNull();
  expect(mockNotice).not.toHaveBeenCalled();
});

it('floor user who is not a personal owner: no banner, nothing read', async () => {
  mockPortal.mockResolvedValue({ access: { kind: 'floor', via: 'agent', role: 'agent' }, user, supabase: client });
  expect(await render()).toBeNull();
  expect(mockNotice).not.toHaveBeenCalled();
});

it('impersonating: no banner, nothing read', async () => {
  mockImpersonation.mockResolvedValue({ target_email: 't@example.test', target_name: 'T' });
  expect(await render()).toBeNull();
  expect(mockNotice).not.toHaveBeenCalled();
  expect(mockPortal).not.toHaveBeenCalled();
});
