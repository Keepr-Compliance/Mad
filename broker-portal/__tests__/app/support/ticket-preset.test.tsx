/**
 * Support ticket presets — BACKLOG-3080 (the My Transactions "Contact sales").
 *
 * Only a preset KEY is read from the URL, looked up as an OWN key; the fixed
 * texts are never overridden by URL text. The dashboard New Ticket page is the
 * only caller that passes a preset; the public /support/new is unchanged.
 *
 * support_categories fixture: columns from information_schema (id, name, slug,
 * description, parent_id, sort_order, is_active, metadata, created_at); names,
 * slugs, parentage, sort_order, is_active and metadata of the two rows from a
 * production read (2026-09-25); ids invented.
 */

import { render, waitFor, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

const mockCreateTicket = jest.fn(async (_input: Record<string, unknown>) => ({ id: 'ticket-3080', ticket_number: 1 }));
const mockGetCategories = jest.fn();
jest.mock('@/lib/support-queries', () => ({
  ...jest.requireActual('@/lib/support-queries'),
  createTicket: (input: Record<string, unknown>) => mockCreateTicket(input),
  getCategories: () => mockGetCategories(),
  uploadAttachment: jest.fn(),
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({
        data: { user: { id: 'u', email: 'agent-3080@fixture.example.test', user_metadata: { full_name: 'Robin Fixture' } } },
      }),
    },
  }),
}));
jest.mock('@/app/support/components/BrowserDiagnostics', () => ({
  useBrowserDiagnostics: () => null,
  BrowserDiagnostics: () => null,
}));
const mockUseSearchParams = jest.fn(() => new URLSearchParams());
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => mockUseSearchParams(),
}));

import {
  MY_TRANSACTIONS_UPGRADE_HREF,
  TICKET_PRESETS,
  presetCategoryIds,
  resolveTicketPreset,
} from '@/lib/support/ticketPresets';
import { TicketForm } from '@/app/support/components/TicketForm';
import DashboardNewTicketPage from '@/app/dashboard/support/new/page';
import PublicNewTicketPage from '@/app/support/new/page';

const BILLING_ID = '00000000-0000-4000-8000-0000003080d1'; // pii-allow-uuid: invented fixture id
const PLAN_SEAT_ID = '00000000-0000-4000-8000-0000003080d2'; // pii-allow-uuid: invented fixture id
const OTHER_ID = '00000000-0000-4000-8000-0000003080d3'; // pii-allow-uuid: invented fixture id
const CATEGORY_ROWS = [
  {
    id: OTHER_ID,
    name: 'Technical Issue',
    slug: 'technical-issue',
    description: null,
    parent_id: null,
    sort_order: 1,
    is_active: true,
    metadata: null,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: BILLING_ID,
    name: 'Billing & Subscription',
    slug: 'billing-subscription',
    description: null,
    parent_id: null,
    sort_order: 3,
    is_active: true,
    metadata: null,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: PLAN_SEAT_ID,
    name: 'Plan/seat change',
    slug: 'plan-seat-change',
    description: null,
    parent_id: BILLING_ID,
    sort_order: 2,
    is_active: true,
    metadata: null,
    created_at: '2026-01-01T00:00:00Z',
  },
];

const FIXED = TICKET_PRESETS['my-transactions-upgrade'];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCategories.mockResolvedValue(CATEGORY_ROWS);
  mockUseSearchParams.mockReturnValue(new URLSearchParams());
});

describe('resolveTicketPreset (C-M12)', () => {
  it('the known key -> exactly the fixed preset; URL text is ignored', () => {
    expect(
      resolveTicketPreset({ preset: 'my-transactions-upgrade', subject: 'EVIL', description: 'EVIL' })
    ).toEqual({
      categorySlug: 'billing-subscription',
      subcategorySlug: 'plan-seat-change',
      subject: 'Upgrade request: My Transactions',
      description:
        "I'd like my brokerage's plan to include My Transactions so I can view my submitted transactions on the web.",
    });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['no params', {}],
    ['unknown key', { preset: 'free-upgrade' }],
    ['array value', { preset: ['my-transactions-upgrade'] }],
    ['__proto__', { preset: '__proto__' }],
    ['constructor', { preset: 'constructor' }],
    ['toString', { preset: 'toString' }],
    ['hasOwnProperty', { preset: 'hasOwnProperty' }],
    ['text without a preset', { subject: 'EVIL', description: 'EVIL' }],
  ] as [string, Record<string, string | string[]> | null | undefined][])('%s -> null', (_n, params) => {
    expect(resolveTicketPreset(params)).toBeNull();
  });

  it('the upsell link names the preset key', () => {
    expect(MY_TRANSACTIONS_UPGRADE_HREF).toBe('/dashboard/support/new?preset=my-transactions-upgrade');
  });
});

describe('presetCategoryIds', () => {
  const { buildCategoryTree } = jest.requireActual('@/lib/support-queries');
  it('maps the slugs to ids from the loaded tree', () => {
    expect(presetCategoryIds(FIXED, buildCategoryTree(CATEGORY_ROWS))).toEqual({
      categoryId: BILLING_ID,
      subcategoryId: PLAN_SEAT_ID,
    });
  });
  it("a missing slug -> ''", () => {
    expect(presetCategoryIds(FIXED, buildCategoryTree(CATEGORY_ROWS.filter((c) => c.id !== PLAN_SEAT_ID)))).toEqual({
      categoryId: BILLING_ID,
      subcategoryId: '',
    });
    expect(presetCategoryIds(FIXED, buildCategoryTree([CATEGORY_ROWS[0]]))).toEqual({ categoryId: '', subcategoryId: '' });
  });
});

const field = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

describe('TicketForm with a preset', () => {
  it('fills subject, description, category and subcategory', async () => {
    render(<TicketForm preset={FIXED} />);
    await waitFor(() => expect(field('category').value).toBe(BILLING_ID));
    await waitFor(() => expect(field('subcategory')?.value).toBe(PLAN_SEAT_ID));
    expect(field('subject').value).toBe(FIXED.subject);
    expect(field('description').value).toBe(FIXED.description);
  });

  it('never reads URL text, even when the URL carries some', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('subject=EVIL&description=EVIL'));
    render(<TicketForm preset={FIXED} />);
    await waitFor(() => expect(field('category').value).toBe(BILLING_ID));
    expect(field('subject').value).toBe(FIXED.subject);
    expect(document.body.innerHTML).not.toContain('EVIL');
  });

  it('every field stays editable', async () => {
    render(<TicketForm preset={FIXED} />);
    await waitFor(() => expect(field('category').value).toBe(BILLING_ID));
    fireEvent.change(field('subject'), { target: { value: 'My own words' } });
    expect(field('subject').value).toBe('My own words');
  });

  it('submits once, through the existing createTicket, with the preset fields', async () => {
    render(<TicketForm preset={FIXED} />);
    await waitFor(() => expect(field('subcategory')?.value).toBe(PLAN_SEAT_ID));
    fireEvent.click(screen.getByRole('button', { name: 'Submit Ticket' }));
    await waitFor(() => expect(mockCreateTicket).toHaveBeenCalledTimes(1));
    expect(mockCreateTicket.mock.calls[0][0]).toMatchObject({
      subject: FIXED.subject,
      description: FIXED.description,
      category_id: BILLING_ID,
      subcategory_id: PLAN_SEAT_ID,
    });
  });

  it('without a preset the form is blank', async () => {
    render(<TicketForm />);
    await waitFor(() => expect(mockGetCategories).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('option', { name: 'Billing & Subscription' })).toBeInTheDocument());
    expect(field('category').value).toBe('');
    expect(field('subject').value).toBe('');
    expect(field('description').value).toBe('');
  });
});

/** The TicketForm element a page renders, and its props. */
function ticketFormProps(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = ticketFormProps(child);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === TicketForm) return el.props as Record<string, unknown>;
  return ticketFormProps(el.props?.children);
}

describe('the pages (R12)', () => {
  it('the dashboard page passes the fixed preset for the key, ignoring URL text', async () => {
    const el = await DashboardNewTicketPage({
      searchParams: Promise.resolve({ preset: 'my-transactions-upgrade', subject: 'EVIL', description: 'EVIL' }),
    });
    expect(ticketFormProps(el)).toEqual({ preset: FIXED });
  });

  it('the dashboard page passes null for no key, text only, or a prototype key', async () => {
    for (const params of [{}, { subject: 'EVIL', description: 'EVIL' }, { preset: '__proto__' }]) {
      const el = await DashboardNewTicketPage({ searchParams: Promise.resolve(params) });
      expect(ticketFormProps(el)).toEqual({ preset: null });
    }
  });

  it('the public /support/new passes no preset and renders blank with ?preset= present', async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams('preset=my-transactions-upgrade&subject=EVIL'));
    const el = PublicNewTicketPage() as React.ReactElement;
    expect(ticketFormProps(el)).toEqual({});
    render(el);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Billing & Subscription' })).toBeInTheDocument());
    expect(field('category').value).toBe('');
    expect(field('subject').value).toBe('');
    expect(document.body.innerHTML).not.toContain('EVIL');
  });
});
