// @vitest-environment jsdom
/**
 * BACKLOG-4011: the Email Log panel styles a 'queued' row and labels 'receipt' and
 * 'ticket_resolved'. Asserted through a render of the real panel (the maps are module-private);
 * getEmailDeliveryLogs is mocked with rows shaped like EmailDeliveryLogRow.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EmailDeliveryLogRow } from '@/lib/support-queries';

const ROWS: EmailDeliveryLogRow[] = [
  { id: 'l1', email_type: 'receipt', recipient_email: 'a@example.test', status: 'queued', error_message: 'HTTP 503', metadata: { subject: 'Your receipt' }, created_at: '2026-11-07T10:00:00Z' },
  { id: 'l2', email_type: 'ticket_resolved', recipient_email: 'a@example.test', status: 'sent', error_message: null, metadata: {}, created_at: '2026-11-07T09:00:00Z' },
];

vi.mock('@/lib/support-queries', () => ({
  getEmailDeliveryLogs: vi.fn(async () => ROWS),
}));

afterEach(cleanup);

async function openPanel() {
  const { EmailLogPanel } = await import('@/app/dashboard/support/components/EmailLogPanel');
  render(<EmailLogPanel recipientEmail="a@example.test" />);
  fireEvent.click(screen.getByRole('button', { name: /Email Log/ }));
  await screen.findByText('Receipt');
}

describe('BACKLOG-4011 EmailLogPanel', () => {
  it("labels 'receipt' as Receipt and 'ticket_resolved' as Resolved", async () => {
    await openPanel();
    expect(screen.getByText('Receipt')).toBeTruthy();
    expect(screen.getByText('Resolved')).toBeTruthy();
    expect(screen.queryByText('receipt')).toBeNull();
    expect(screen.queryByText('ticket_resolved')).toBeNull();
  });

  it("gives a 'queued' status its own chip style, not the unknown-status gray", async () => {
    await openPanel();
    const chip = screen.getByText('queued');
    expect(chip.className).toContain('bg-indigo-100');
    expect(chip.className).not.toContain('bg-gray-100');
  });
});
