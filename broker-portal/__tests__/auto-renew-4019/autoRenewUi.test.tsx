/**
 * BACKLOG-4019: the broker Billing page's auto-renew block and the plan-end line.
 * planEnd shapes are broker_get_plan_end's output (migration 20261020220000 §7), as read by
 * lib/billing/planEnd.ts.
 */

import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';

const mockSetAutoRenew = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/actions/autoRenew', () => ({ setAutoRenew: (...a: unknown[]) => mockSetAutoRenew(...a) }));

import { AutoRenewBlock } from '@/components/billing/AutoRenewBlock';
import { planEndLine, type PlanEnd } from '@/lib/billing/planEnd';

const ORG = '00000000-0000-0000-0000-000000000000';
const pe = (over: Partial<PlanEnd>): PlanEnd => ({
  state: 'renewing',
  endsOn: null,
  periodEnd: '2026-10-30T19:00:00+00:00',
  canChange: true,
  version: 3,
  ...over,
});

beforeEach(() => mockSetAutoRenew.mockReset());

describe('AutoRenewBlock', () => {
  it('renewing + can change: "Turn off auto-renew" asks first, then calls the action with the version', async () => {
    mockSetAutoRenew.mockResolvedValue({ ok: true, error: null });
    render(<AutoRenewBlock organizationId={ORG} planEnd={pe({})} />);
    expect(screen.getByText('On. Your plan renews each month.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off auto-renew' }));
    expect(mockSetAutoRenew).not.toHaveBeenCalled();
    expect(screen.getByText('Turn off auto-renew?')).toBeInTheDocument();
    expect(screen.getByText('Your plan ends on Oct 30, 2026. Contact Keepr to restart it after that.')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Turn off auto-renew' });
    fireEvent.click(buttons[buttons.length - 1]);
    await screen.findByText('On. Your plan renews each month.');
    expect(mockSetAutoRenew).toHaveBeenCalledWith(ORG, false, 3);
  });

  it('ending + can change: "Turn auto-renew back on", no dialog', async () => {
    mockSetAutoRenew.mockResolvedValue({ ok: true, error: null });
    render(<AutoRenewBlock organizationId={ORG} planEnd={pe({ state: 'ending', endsOn: '2026-10-30T19:00:00+00:00' })} />);
    expect(screen.getByText('Off. Your plan ends on Oct 30, 2026.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn auto-renew back on' }));
    expect(mockSetAutoRenew).toHaveBeenCalledWith(ORG, true, 3);
  });

  it('C-UI2: cannot change (a broker who is not the contact) -> state only, no buttons', () => {
    render(<AutoRenewBlock organizationId={ORG} planEnd={pe({ canChange: false })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ended -> the end date, no buttons even when can_change were true', () => {
    render(<AutoRenewBlock organizationId={ORG} planEnd={pe({ state: 'ended', endsOn: '2026-10-30T19:00:00+00:00', canChange: true })} />);
    expect(screen.getByText('Your plan ended on Oct 30, 2026.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('planEndLine (dashboard + Billing page)', () => {
  it('nothing while renewing or without a read', () => {
    expect(planEndLine(pe({}))).toBeNull();
    expect(planEndLine(null)).toBeNull();
  });
  it('ending: who can change it is told where; others to contact support', () => {
    const ending = pe({ state: 'ending', endsOn: '2026-10-30T19:00:00+00:00' });
    expect(planEndLine(ending)).toBe('Your plan ends on Oct 30, 2026. Turn auto-renew back on in Billing.');
    expect(planEndLine({ ...ending, canChange: false })).toBe('Your plan ends on Oct 30, 2026. Contact support to keep it.');
  });
  it('ended', () => {
    expect(planEndLine(pe({ state: 'ended', endsOn: '2026-10-30T19:00:00+00:00' }))).toBe('Your plan ended on Oct 30, 2026. Contact support to restart it.');
  });
});
