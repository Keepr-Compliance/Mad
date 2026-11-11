/**
 * BACKLOG-3962 PR3b: the capture table on /dashboard/settings/domain and the personal-owner
 * banner. Candidate shapes are transcribed from domain_capture_candidates and caller_capture_notice
 * (supabase/migrations/20261112113000_backlog_3962_domain_capture.sql).
 */

import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react';

const mockRefresh = jest.fn();
let mockParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
  useSearchParams: () => mockParams,
}));
jest.mock('@/lib/actions/domainCapture', () => ({
  startCapture: jest.fn(),
  cancelCapture: jest.fn(),
  optOutSelf: jest.fn(),
}));

import { cancelCapture, optOutSelf, startCapture } from '@/lib/actions/domainCapture';
import { DOMAIN_CAPTURE_BILLING_SETUP } from '@/lib/domain/captureMessages';
import {
  CAPTURE_KEEP_BUTTON,
  CAPTURE_KEEP_DONE,
  CAPTURE_REASON_COPY,
  CAPTURE_EMPTY_TITLE,
  captureStartConfirmText,
  formatCaptureDate,
} from '@/lib/domain/captureCopy';
import { loadCaptureNotice, loadCaptureSection, type CaptureDomainView } from '@/lib/domain/captureView';
import CaptureSection from '@/app/dashboard/settings/domain/CaptureSection';
import CaptureNoticeBanner from '@/components/CaptureNoticeBanner';
import { CAPTURE_BANNER_DETAIL } from '@/lib/domain/captureCopy';
import type { DomainClaimView } from '@/lib/domain/claims';

const start = startCapture as jest.Mock;
const cancel = cancelCapture as jest.Mock;
const optOut = optOutSelf as jest.Mock;

const FUTURE = new Date(Date.now() + 10 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

const candidate = (over: Record<string, unknown>) => ({
  user_id: 'u-x', email: 'x@a-brokerage.example', attestation: 'email_confirmed', convertible: true,
  reason: null, switch_id: null, switch_at: null, notice_delivered: null, ...over,
});

const CANDIDATES = [
  candidate({ user_id: 'u-can', email: 'can@a-brokerage.example', name: 'Casey Can' }),
  candidate({ user_id: 'u-can2', email: 'can2@a-brokerage.example' }),
  candidate({ user_id: 'u-tenant', email: 'ms@a-brokerage.example', attestation: null, convertible: false, reason: 'no_tenant' }),
  candidate({ user_id: 'u-attest', email: 'plain@a-brokerage.example', attestation: null, convertible: false, reason: 'no_attestation' }),
  candidate({ user_id: 'u-sched', email: 'sched@a-brokerage.example', switch_id: 's-sched', switch_at: FUTURE, notice_delivered: true }),
  candidate({ user_id: 'u-retry', email: 'retry@a-brokerage.example', switch_id: 's-retry', switch_at: FUTURE, notice_delivered: null }),
  candidate({ user_id: 'u-wait', email: 'wait@a-brokerage.example', switch_id: 's-wait', switch_at: PAST, notice_delivered: true }),
  candidate({ user_id: 'u-bill', email: 'bill@a-brokerage.example', switch_id: 's-bill', switch_at: PAST, notice_delivered: true, last_defer_reason: 'billing_setup_incomplete' }),
  candidate({ user_id: 'u-dns', email: 'dns@a-brokerage.example', switch_id: 's-dns', switch_at: PAST, notice_delivered: true, last_defer_reason: 'dns_not_fresh' }),
  candidate({ user_id: 'u-opted', email: 'opted@a-brokerage.example', attestation: null, convertible: false, reason: 'opted_out' }),
  candidate({ user_id: 'u-undeliv', email: 'undeliv@a-brokerage.example' }),
];

// domain_capture_history rows (switch_id, claim_id, user_id, status, reason, switch_at, email, name, last_defer_reason)
const hist = (over: Record<string, unknown>) => ({
  switch_id: 's-h', claim_id: 'c1', user_id: 'u-h', status: 'cancelled', reason: null, switch_at: PAST,
  email: 'h@a-brokerage.example', name: 'h@a-brokerage.example', last_defer_reason: null, ...over,
});
const ENDED = [
  hist({ switch_id: 's-live', user_id: 'u-sched', status: 'scheduled', email: 'sched@a-brokerage.example' }),
  hist({ switch_id: 's-h1', user_id: 'u-opted', email: 'opted@a-brokerage.example', status: 'opted_out', reason: 'opted_out' }),
  hist({ switch_id: 's-h2', user_id: 'u-undeliv', email: 'undeliv@a-brokerage.example', status: 'cancelled', reason: 'notice_undelivered' }),
  hist({ switch_id: 's-h3', user_id: 'u-moved', email: 'moved@a-brokerage.example', name: 'Morgan Moved', status: 'switched' }),
  hist({ switch_id: 's-h4', user_id: 'u-susp', email: 'susp@a-brokerage.example', status: 'cancelled', reason: 'brokerage_suspended' }),
  hist({ switch_id: 's-h5', claim_id: 'c-other', user_id: 'u-elsewhere', email: 'x@other.example', status: 'switched' }),
];

const claim = (over: Partial<DomainClaimView>): DomainClaimView => ({
  id: 'c1', domain: 'a-brokerage.example', unicodeDomain: 'a-brokerage.example', isInternationalized: false,
  status: 'verified', recordName: '_keepr.a-brokerage.example', recordValue: 'v', verifiedAt: null,
  lastCheckedAt: null, lastCheckResult: null, addedBy: null, ...over,
});

function rpcFor(candidates: unknown[], history: unknown[]) {
  return jest.fn(async (fn: string) => {
    if (fn === 'domain_capture_candidates') return { data: { success: true, domain: 'a-brokerage.example', candidates }, error: null };
    if (fn === 'domain_capture_history') return { data: { success: true, switches: history }, error: null };
    return { data: null, error: { code: 'PGRST202' } };
  });
}

async function loadView(candidates: unknown[] = CANDIDATES, ended: unknown[] = ENDED): Promise<CaptureDomainView[]> {
  const out = await loadCaptureSection(
    { ok: true, supabase: { rpc: rpcFor(candidates, ended) } as never, userId: 'admin', organizationId: 'org-session' },
    [claim({})],
  );
  return out as CaptureDomainView[];
}

const row = (userId: string) => within(screen.getByTestId(`capture-row-${userId}`));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = new URLSearchParams();
});

describe('loadCaptureSection gate', () => {
  it('a caller without domain access gets no section and nothing is read', async () => {
    const out = await loadCaptureSection({ ok: false }, [claim({})]);
    expect(out).toBeNull();
  });

  it('no verified domain -> no section', async () => {
    const rpc = jest.fn();
    const out = await loadCaptureSection(
      { ok: true, supabase: { rpc } as never, userId: 'admin', organizationId: 'org-session' },
      [claim({ status: 'pending' }), claim({ id: 'c2', status: 'lapsed' })],
    );
    expect(out).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reads candidates and history on the session client with the session organization', async () => {
    const rpc = rpcFor([], []);
    await loadCaptureSection(
      { ok: true, supabase: { rpc } as never, userId: 'admin', organizationId: 'org-session' },
      [claim({})],
    );
    expect(rpc).toHaveBeenCalledWith('domain_capture_candidates', { p_org: 'org-session', p_claim: 'c1' });
    expect(rpc).toHaveBeenCalledWith('domain_capture_history', { p_org: 'org-session' });
  });

  it('the page no longer uses the service client', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../app/dashboard/settings/domain/page.tsx'), 'utf8');
    expect(src).not.toMatch(/createServiceClient|supabase\/service/);
  });

  it('a missing function shows the not-available state', async () => {
    const rpc = jest.fn(async () => ({ data: null, error: { code: 'PGRST202' } }));
    const out = await loadCaptureSection(
      { ok: true, supabase: { rpc } as never, userId: 'admin', organizationId: 'org-session' },
      [claim({})],
    );
    expect(out?.[0].state).toBe('unavailable');
  });
});

describe('capture table', () => {
  it('renders every row with its status and reason in plain words', async () => {
    render(<CaptureSection domains={await loadView()} />);
    expect(row('u-can').getByText('Can move')).toBeTruthy();
    expect(row('u-tenant').getByText("Can't move automatically")).toBeTruthy();
    expect(row('u-tenant').getByText(CAPTURE_REASON_COPY.no_tenant)).toBeTruthy();
    expect(row('u-attest').getByText(CAPTURE_REASON_COPY.no_attestation)).toBeTruthy();
    expect(row('u-sched').getByText(`Scheduled for ${formatCaptureDate(FUTURE)}`)).toBeTruthy();
    expect(row('u-retry').getByText('The notice email is being retried.')).toBeTruthy();
    expect(row('u-wait').getByText('Waiting to move')).toBeTruthy();
    expect(row('u-bill').getByText('Waiting on billing setup')).toBeTruthy();
    expect(row('u-dns').getByText('Waiting on DNS re-check')).toBeTruthy();
    expect(row('u-opted').getByText('Opted out')).toBeTruthy();
    expect(row('u-opted').getByText(CAPTURE_REASON_COPY.opted_out)).toBeTruthy();
    expect(row('u-undeliv').getByText('Cancelled — notice not delivered')).toBeTruthy();
    expect(row('u-moved').getByText('Switched')).toBeTruthy();
    expect(row('u-susp').getByText('Cancelled — brokerage suspended')).toBeTruthy();
    expect(screen.queryByTestId('capture-row-u-elsewhere')).toBeNull();
  });

  it('shows the name with the email under it, or the email alone', async () => {
    render(<CaptureSection domains={await loadView()} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Select', 'Name', 'Status', 'Actions']);
    const cells = row('u-can').getAllByRole('cell').map((c) => c.textContent);
    expect(cells[1]).toBe('Casey Cancan@a-brokerage.example');
    expect(row('u-moved').getByText('Morgan Moved')).toBeTruthy();
    expect(row('u-can2').getAllByRole('cell')[1].textContent).toBe('can2@a-brokerage.example');
  });

  it('only convertible rows without a live or final move have a checkbox', async () => {
    render(<CaptureSection domains={await loadView()} />);
    const ticked = ['u-can', 'u-can2', 'u-undeliv'];
    for (const id of ['u-can', 'u-can2', 'u-tenant', 'u-attest', 'u-sched', 'u-wait', 'u-bill', 'u-opted', 'u-undeliv', 'u-moved', 'u-susp']) {
      expect(row(id).queryAllByRole('checkbox')).toHaveLength(ticked.includes(id) ? 1 : 0);
    }
  });

  it('Start is disabled until someone is selected', async () => {
    render(<CaptureSection domains={await loadView()} />);
    const btn = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(row('u-can').getByRole('checkbox'));
    expect(btn.disabled).toBe(false);
    fireEvent.click(row('u-can').getByRole('checkbox'));
    expect(btn.disabled).toBe(true);
  });

  it('confirm text names the count and the move date; Start sends only the claim and the people', async () => {
    start.mockResolvedValue({ success: true, message: '2 scheduled to move in 14 days.' });
    render(<CaptureSection domains={await loadView()} />);
    fireEvent.click(row('u-can').getByRole('checkbox'));
    fireEvent.click(row('u-can2').getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const date = formatCaptureDate(new Date(Date.now() + 14 * 86_400_000).toISOString());
    expect(screen.getByTestId('capture-start-confirm-text').textContent).toBe(captureStartConfirmText(2, date));
    expect(screen.getByTestId('capture-start-confirm-text').textContent).toBe(
      `These 2 people get an email today and move on ${date}. Each can opt out until then.`,
    );
    expect(start).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start the move' }));
    });
    expect(start).toHaveBeenCalledTimes(1);
    const arg = start.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(['claimId', 'userIds']);
    expect(arg.claimId).toBe('c1');
    expect(arg.userIds.sort()).toEqual(['u-can', 'u-can2']);
    expect(await screen.findByText('2 scheduled to move in 14 days.')).toBeTruthy();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('a refused start shows the action message', async () => {
    start.mockResolvedValue({ success: false, message: DOMAIN_CAPTURE_BILLING_SETUP });
    render(<CaptureSection domains={await loadView()} />);
    fireEvent.click(row('u-can').getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start the move' }));
    });
    expect(await screen.findByText(DOMAIN_CAPTURE_BILLING_SETUP)).toBeTruthy();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('Cancel asks first, then calls cancel with the switch id only', async () => {
    cancel.mockResolvedValue({ success: true, message: 'The move was cancelled.' });
    render(<CaptureSection domains={await loadView()} />);
    fireEvent.click(row('u-sched').getByRole('button', { name: 'Cancel' }));
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the move' }));
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]).toEqual(['s-sched']);
  });

  it('no candidates -> empty state', async () => {
    render(<CaptureSection domains={await loadView([], [])} />);
    expect(screen.getByText(CAPTURE_EMPTY_TITLE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });
});

describe('personal-owner banner', () => {
  const NOTICE = { switchId: 's-me', brokerageName: 'A Brokerage', domain: 'a-brokerage.example', switchAt: FUTURE };

  it('loadCaptureNotice: null without a scheduled move, the move when there is one', async () => {
    const none = jest.fn(async () => ({ data: { success: true, switches: [] }, error: null }));
    expect(await loadCaptureNotice({ rpc: none } as never)).toBeNull();
    const missing = jest.fn(async () => ({ data: null, error: { code: 'PGRST202' } }));
    expect(await loadCaptureNotice({ rpc: missing } as never)).toBeNull();
    const one = jest.fn(async () => ({
      data: { success: true, switches: [{ switch_id: 's-me', brokerage_name: 'A Brokerage', domain: 'a-brokerage.example', switch_at: FUTURE }] },
      error: null,
    }));
    expect(await loadCaptureNotice({ rpc: one } as never)).toEqual(NOTICE);
    expect(one).toHaveBeenCalledWith('caller_capture_notice');
  });

  it('shows the brokerage and date; opting out needs the confirm step', async () => {
    optOut.mockResolvedValue({ success: true, message: 'ok' });
    render(<CaptureNoticeBanner notice={NOTICE} />);
    expect(screen.getByText(`A Brokerage will move your Keepr account on ${formatCaptureDate(FUTURE)}.`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: CAPTURE_KEEP_BUTTON }));
    expect(optOut).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: CAPTURE_KEEP_BUTTON }));
    });
    expect(optOut).toHaveBeenCalledTimes(1);
    expect(optOut).toHaveBeenCalledWith({ switchId: 's-me', confirm: true });
    expect(await screen.findByText(CAPTURE_KEEP_DONE)).toBeTruthy();
  });

  it('?capture=notice only displays: highlights and focuses, calls nothing', async () => {
    mockParams = new URLSearchParams('capture=notice');
    render(<CaptureNoticeBanner notice={NOTICE} />);
    await waitFor(() => expect(document.activeElement?.textContent).toBe(CAPTURE_KEEP_BUTTON));
    expect(screen.getByTestId('capture-notice-banner').getAttribute('data-from-email')).toBe('true');
    expect(optOut).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('capture banner copy (BACKLOG-3962)', () => {
  it('uses future tense for the post-move sentence', () => {
    expect(CAPTURE_BANNER_DETAIL).toContain('After the move, the brokerage will manage this account and can end your access to it.');
  });
});
