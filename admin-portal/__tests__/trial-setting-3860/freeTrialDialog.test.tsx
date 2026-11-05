// @vitest-environment jsdom
/**
 * BACKLOG-3860 PR-3 fix-up: the Free trial dialog end to end.
 * Tick/untick and days, Save shows the confirm line without calling the action, Confirm calls the
 * action once with the entered values, a refusal shows the error and keeps the dialog open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PRESENT_OFF, PRESENT_ON } from './fixtures';

const refresh = vi.fn();
const action = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/actions/trialSetting', () => ({ setSoloTrialAction: (...a: unknown[]) => action(...a) }));

import { FreeTrialCard } from '@/app/dashboard/plans/components/FreeTrialCard';

beforeEach(() => {
  action.mockReset();
  refresh.mockReset();
  action.mockResolvedValue({ ok: true, error: null });
});
afterEach(cleanup);

function openDialog(setting: typeof PRESENT_OFF) {
  render(<FreeTrialCard setting={setting} lastChange={null} canEdit />);
  fireEvent.click(screen.getByTestId('free-trial-edit'));
}
const box = () => screen.getByLabelText('Free trial on') as HTMLElement;
const days = () => document.getElementById('free-trial-days') as HTMLInputElement;
const checkedNow = () => box().getAttribute('data-state') === 'checked' || (box() as HTMLInputElement).checked === true;

describe('Free trial dialog', () => {
  it('ticking on and typing days: Save shows the confirm line, the action is not called yet; Confirm calls it once with those values', async () => {
    openDialog(PRESENT_OFF);
    expect(checkedNow()).toBe(false);
    fireEvent.click(box());
    fireEvent.change(days(), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('free-trial-confirm').textContent).toContain('On, 30 days');
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith(true, 30);
  });

  it('unticking an on setting sends off with the typed days', async () => {
    openDialog(PRESENT_ON);
    expect(checkedNow()).toBe(true);
    fireEvent.click(box());
    fireEvent.change(days(), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(action).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith(false, 7);
  });

  it('a refusal shows the error and the dialog stays open', async () => {
    action.mockResolvedValue({ ok: false, error: 'Only a Super Admin can change the free trial.' });
    openDialog(PRESENT_OFF);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const err = await screen.findByTestId('free-trial-error');
    expect(err.textContent).toBe('Only a Super Admin can change the free trial.');
    expect(screen.getByLabelText('Free trial on')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a bad days value stops at Save: error shown, no confirm line, no call', () => {
    openDialog(PRESENT_OFF);
    fireEvent.change(days(), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('free-trial-error')).toBeTruthy();
    expect(screen.queryByTestId('free-trial-confirm')).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });
});
