/**
 * BACKLOG-3798 layout harness — markup dumps (NOT a CI test).
 *
 * Renders the real components in jsdom and writes each container's HTML to
 * $DUMP_DIR/<name>.html. run.sh then compiles the real Tailwind CSS for that
 * markup and measures it in Chromium at several widths (measure.cjs).
 *
 * Run through run.sh only. Uses its own jest config (jest.harness.config.js),
 * so the portal's CI jest run never picks this file up.
 *
 * Every id, name and address is invented. The member shape follows the select
 * in app/dashboard/users/page.tsx; submission rows come from
 * __tests__/helpers/submissionRows.ts.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { writeFileSync } from 'fs';
import { join } from 'path';
import React from 'react';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  createPostgrestEmulator,
  type Row,
} from '../../__tests__/helpers/postgrestEmulator';
import { submissionRow } from '../../__tests__/helpers/submissionRows';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../../__tests__/fixtures/orgFeatures';

const mockEmulator = createPostgrestEmulator();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
  usePathname: () => '/dashboard/submissions/sub-1',
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element
  default: (p: { src: string; alt: string }) => <img src={p.src} alt={p.alt} />,
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: null } }),
      getSession: async () => ({ data: { session: null } }),
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'about:blank' }, error: null }) }) },
  }),
}));
jest.mock('@/lib/support-queries', () => ({
  createTicket: jest.fn(),
  getCategories: jest.fn(async () => []),
  buildCategoryTree: () => [],
  uploadAttachment: jest.fn(),
}));
jest.mock('html2canvas', () => jest.fn());
jest.mock('heic2any', () => jest.fn());
jest.mock('@/components/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }));
jest.mock('@/components/submission/AttachmentViewerModal', () => ({ AttachmentViewerModal: () => null }));
jest.mock('@/lib/actions/submissionChecklists', () => ({
  setReviewerCheck: jest.fn(),
  addChecklistAtReview: jest.fn(),
  removeChecklistAtReview: jest.fn(),
  restoreChecklistAtReview: jest.fn(),
}));
jest.mock('@/lib/impersonation-guards', () => ({
  getDataClient: jest.fn(async () => ({
    client: { from: (t: string) => mockEmulator.from(t) },
    impersonation: null,
    organizationId: null,
  })),
  getTargetOrganizationId: (id: string | null) => id || undefined,
}));
jest.mock('@/lib/feature-gate', () => {
  const actual = jest.requireActual('@/lib/feature-gate');
  return {
    ...actual,
    getOrgFeatures: jest.fn(async (orgId: string) =>
      withFeature({ ...ORG_WITHOUT_PLAN_FEATURES, org_id: orgId }, 'broker_portal_access', true)
    ),
  };
});
jest.mock('@/lib/auth/portalAccess', () => ({ requireFullPortalAccess: jest.fn(async () => ({ ok: true })) }));
jest.mock('@/components/submission/SubmissionListClient', () => ({
  SubmissionListClient: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DashboardShell } from '@/components/layout/DashboardShell';
import { ReviewActions } from '@/components/submission/ReviewActions';
import { MessageList, type Message } from '@/components/submission/MessageList';
import { AttachmentList } from '@/components/submission/AttachmentList';
import { ChecklistReview } from '@/components/submission/ChecklistReview';
import type { ChecklistSectionView } from '@/lib/submissions/checklistModel';
import UserListClient from '@/components/users/UserListClient';
import UserDetailsCard, { type MemberDetailsData } from '@/components/users/UserDetailsCard';
import SubmissionsPage from '@/app/dashboard/submissions/page';

const DIR = process.env.DUMP_DIR as string;
const dump = (name: string, html: string) => writeFileSync(join(DIR, `${name}.html`), html);

const LONG_EMAIL = 'agent.a.longer-address-for-width@example-brokerage.com';

function setMatchMedia(matches: boolean | null) {
  if (matches === null) {
    // jsdom default: no matchMedia at all
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    return;
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => setMatchMedia(null));

function shell(children: React.ReactNode) {
  return (
    <DashboardShell
      role="broker"
      isImpersonating={false}
      displayName="Broker Name"
      displayEmail="broker@example.com"
      displayRole="broker"
    >
      {children}
    </DashboardShell>
  );
}

const reviewPage = (
  <div className="max-w-7xl mx-auto space-y-6 pb-24">
    <h1>Submission</h1>
    <ReviewActions submission={{ id: 'sub-1', status: 'under_review', organization_id: 'org-1' }} showChecklistHint />
  </div>
);

it('shell-expanded / shell-collapsed / shell-drawer / support-dialog', async () => {
  const { container, getByRole, queryByRole } = render(shell(reviewPage));
  dump('shell-expanded', container.innerHTML);

  fireEvent.click(getByRole('button', { name: 'Collapse sidebar' }));
  dump('shell-collapsed', container.innerHTML);
  fireEvent.click(getByRole('button', { name: 'Expand sidebar' }));

  const open = queryByRole('button', { name: 'Open menu' });
  if (open) {
    fireEvent.click(open);
    dump('shell-drawer', container.innerHTML);
    fireEvent.click(getByRole('button', { name: 'Close menu' }));
  }

  await act(async () => {
    fireEvent.click(getByRole('button', { name: 'Contact Support' }));
  });
  dump('support-dialog', container.innerHTML);
});

const MEMBERS = [1, 2, 3].map((i) => ({
  id: `m${i}`,
  organization_id: 'org-1',
  user_id: `u${i}`,
  role: 'agent',
  license_status: 'active',
  invited_email: null,
  invitation_token: null,
  invitation_expires_at: null,
  invited_by: null,
  invited_at: null,
  joined_at: '2024-01-01T00:00:00Z',
  last_invited_at: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  user: { id: `u${i}`, email: LONG_EMAIL, first_name: 'Agent', last_name: `Number${i}`, display_name: null, avatar_url: null },
}));

it('users-wide / users-narrow', () => {
  for (const [name, narrow] of [
    ['users-wide', false],
    ['users-narrow', true],
  ] as const) {
    setMatchMedia(narrow);
    const { container, unmount } = render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <UserListClient initialMembers={MEMBERS as any} currentUserId="u0" currentUserRole="admin" organizationId="org-1" />
    );
    dump(name, container.innerHTML);
    unmount();
  }
});

it('user-details', () => {
  const member: MemberDetailsData = {
    id: 'm1',
    user_id: 'u1',
    role: 'agent',
    license_status: 'active',
    invited_email: null,
    invited_at: null,
    joined_at: '2024-01-01T00:00:00Z',
    provisioned_by: null,
    provisioned_at: null,
    scim_synced_at: null,
    provisioning_metadata: null,
    idp_groups: null,
    invited_by: null,
    last_invited_at: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    user: {
      id: 'u1',
      email: LONG_EMAIL,
      first_name: 'Agentwithaverylongfirstname',
      last_name: 'Andaverylonglastname',
      display_name: null,
      avatar_url: null,
      last_login_at: null,
      created_at: '2024-01-01T00:00:00Z',
      last_sso_login_at: null,
      last_sso_provider: null,
      is_managed: false,
    },
  };
  const { container } = render(<UserDetailsCard member={member} currentUserId="u0" currentUserRole="admin" />);
  dump('user-details', container.innerHTML);
});

const MESSAGES: Message[] = [
  {
    id: 'msg-1',
    channel: 'email',
    direction: 'inbound',
    subject: 'Signed purchase contract and addenda for the invented property',
    body_text: 'Attached are the signed documents.',
    sent_at: '2026-10-02T22:15:00+00:00',
    has_attachments: false,
    attachment_count: 0,
    thread_id: 't1',
    message_type: 'email',
    participants: { from: 'Avery Example <avery@fixture.example.test>', to: ['agent@fixture.example.test'] },
  },
  {
    id: 'msg-2',
    channel: 'sms',
    direction: 'outbound',
    subject: null,
    body_text: 'On my way to the inspection now.',
    sent_at: '2026-10-03T16:05:00+00:00',
    has_attachments: false,
    attachment_count: 0,
    thread_id: 't2',
    message_type: 'text',
    participants: { from: '+12065550142', chat_members: ['+12065550143'] },
  },
];

const ATTACHMENTS = [
  { id: 'a1', filename: 'Purchase-Agreement-Signed.pdf', mime_type: 'application/pdf', file_size_bytes: 120000, storage_path: 'x/a1', document_type: null },
  { id: 'a2', filename: 'inspection-photo.jpg', mime_type: 'image/jpeg', file_size_bytes: 300000, storage_path: 'x/a2', document_type: null },
];

it('messages / attachments / checklist', () => {
  let r = render(<MessageList messages={MESSAGES} />);
  dump('messages', r.container.innerHTML);
  r.unmount();

  r = render(<AttachmentList attachments={ATTACHMENTS} />);
  dump('attachments', r.container.innerHTML);
  r.unmount();

  const sections: ChecklistSectionView[] = [
    {
      id: 'hdr-contract',
      templateId: 'tpl-contract',
      name: 'Contract documents for a purchase transaction',
      addedAtReviewBy: null,
      addedAtReviewAt: null,
      items: [
        {
          id: 'i-buyer',
          title: 'Buyer representation agreement',
          description: null,
          isRequired: true,
          isChecked: true,
          note: null,
          reviewerChecked: false,
          reviewerCheckedBy: null,
          reviewerCheckedAt: null,
          clearedReviewerId: null,
          clearedAt: null,
          links: [],
        },
      ],
    } as ChecklistSectionView,
  ];
  r = render(
    <ChecklistReview
      submissionId="sub-1"
      status="under_review"
      sections={sections}
      names={null}
      canTick
      canDecide
      templates={[]}
      messages={[]}
      attachments={[]}
    />
  );
  dump('checklist', r.container.innerHTML);
  r.unmount();
});

it('submissions-list', async () => {
  const rows: Row[] = [
    { ...submissionRow({ id: 's1', organizationId: FIXTURE_BROKERAGE_ORG_ID, submittedBy: 'a1', status: 'submitted', parentSubmissionId: null, createdAt: '2026-09-02T00:00:00Z', address: '1234 Invented Boulevard Northwest' }), version: 1 },
    { ...submissionRow({ id: 's2', organizationId: FIXTURE_BROKERAGE_ORG_ID, submittedBy: 'a1', status: 'approved', parentSubmissionId: null, createdAt: '2026-09-01T00:00:00Z', address: '34 Fictional Road' }), version: 1 },
  ];
  mockEmulator.reset();
  mockEmulator.set({ rows: { transaction_submissions: rows } });
  const element = await SubmissionsPage({ searchParams: Promise.resolve({}) });
  const { container } = render(element);
  dump('submissions-list', container.innerHTML);
});
