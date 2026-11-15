/**
 * Reassign on a shared report — BACKLOG-3513 PR-3f.
 *
 * The REAL ReassignReport component and the REAL browser api (definitions-api)
 * run; only the browser Supabase client's rpc and next/navigation are mocked.
 * Reply shapes transcribed from migration 20261112220000:
 * broker_report_reassign_candidates -> [{kind 'person', id, name, detail}] (detail =
 * the role label; never an email); broker_report_reassign -> {success: true}, or the
 * error "Report not found". Ids and names are invented.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import React from 'react';

const DEF = '00000000-0000-4000-8000-0000003513f1'; // pii-allow-uuid: invented fixture id
const P_AGENT = '00000000-0000-4000-8000-0000003513f2'; // pii-allow-uuid: invented fixture id
const P_BROKER = '00000000-0000-4000-8000-0000003513f3'; // pii-allow-uuid: invented fixture id

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
const mockRpc = jest.fn<ReturnType<Rpc>, Parameters<Rpc>>();
const mockRefresh = jest.fn();

jest.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc: mockRpc }) }));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: mockRefresh }),
}));

import { ReassignReport } from '@/components/reports/ReassignReport';

const CANDIDATES = [
  { kind: 'person', id: P_AGENT, name: 'Riley Agent', detail: 'Agent' },
  { kind: 'person', id: P_BROKER, name: 'Sam Broker', detail: 'Broker' },
];

function given(opts: { reassignError?: string } = {}) {
  mockRpc.mockImplementation(async (name) => {
    if (name === 'broker_report_reassign_candidates') return { data: CANDIDATES, error: null };
    if (name === 'broker_report_reassign') {
      return opts.reassignError ? { data: null, error: { message: opts.reassignError } } : { data: { success: true }, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
}

async function openDialog() {
  render(<ReassignReport defId={DEF} name="Q4 deals" kind="full" reassignAvailable />);
  fireEvent.click(screen.getByRole('button', { name: 'Reassign' }));
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('broker_report_reassign_candidates', { p_def: DEF }));
  await waitFor(() => expect(within(dialog).getByRole('button', { name: /New owner/ })).not.toBeDisabled());
  return dialog;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ReassignReport (BACKLOG-3513 PR-3f)', () => {
  it('hidden for an ineligible caller (the database said no)', () => {
    given();
    render(<ReassignReport defId={DEF} name="Q4 deals" kind="full" reassignAvailable={false} />);
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
    expect(screen.queryByTestId('report-reassign')).toBeNull();
  });

  it('hidden for an agent even if the flag were set', () => {
    given();
    render(<ReassignReport defId={DEF} name="Q4 deals" kind="agent" reassignAvailable />);
    expect(screen.queryByRole('button', { name: 'Reassign' })).toBeNull();
  });

  it('the dialog has a visible secondary Cancel and a primary Reassign that waits for a pick', async () => {
    given();
    const dialog = await openDialog();
    expect(within(dialog).getByRole('heading', { name: 'Reassign “Q4 deals”' })).toBeInTheDocument();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel.className).toContain('border');
    expect(cancel.className).not.toContain('hover:bg-accent hover:text-accent-foreground');
    const confirm = within(dialog).getByRole('button', { name: 'Reassign' });
    expect(confirm.className).toContain('bg-primary');
    expect(confirm).toBeDisabled();
    expect(mockRpc.mock.calls.map(([n]) => n)).not.toContain('broker_report_reassign');
  });

  it('pick a person, confirm: one broker_report_reassign call with that person, then refresh', async () => {
    given();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: /New owner/ }));
    expect(screen.getByRole('option', { name: /Sam Broker/ })).toHaveTextContent('Broker');
    fireEvent.click(screen.getByRole('option', { name: /Riley Agent/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reassign' }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('broker_report_reassign', { p_def: DEF, p_new_owner: P_AGENT }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
    expect(mockRpc.mock.calls.filter(([n]) => n === 'broker_report_reassign')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Cancel closes without reassigning', async () => {
    given();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockRpc.mock.calls.map(([n]) => n)).not.toContain('broker_report_reassign');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('a refusal shows an error, keeps the dialog open and does not refresh', async () => {
    given({ reassignError: 'Report not found' });
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: /New owner/ }));
    fireEvent.click(screen.getByRole('option', { name: /Sam Broker/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reassign' }));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('never calls the removed take-over function', async () => {
    given();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: /New owner/ }));
    fireEvent.click(screen.getByRole('option', { name: /Riley Agent/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reassign' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockRpc.mock.calls.map(([n]) => n)).not.toContain('broker_report_take_over');
  });
});
