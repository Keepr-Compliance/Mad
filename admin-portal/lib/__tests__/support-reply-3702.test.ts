/**
 * BACKLOG-3702: support reply emails.
 *
 * - {{agent_name}} is filled with the signed-in staff member's name.
 * - No raw {{token}} survives into customer text.
 * - The reply notification carries the FULL reply with line breaks intact,
 *   and the "X replied" header uses the same staff-name helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getUser = vi.fn();
const rpc = vi.fn();
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ rpc, auth: { getUser } }),
}));

import {
  applyTemplateVariables,
  getStaffDisplayName,
  firstNameFromEmail,
  replyBodyForEmail,
  DEFAULT_STAFF_NAME,
} from '../support-reply';
import { addMessage } from '../support-queries';

describe('getStaffDisplayName', () => {
  it('uses full_name when set', () => {
    expect(getStaffDisplayName({ email: 'jane.doe@example.com', user_metadata: { full_name: 'Jane Doe' } })).toBe('Jane Doe');
  });
  it('falls back to name, then first+last', () => {
    expect(getStaffDisplayName({ user_metadata: { name: 'J. Doe' } })).toBe('J. Doe');
    expect(getStaffDisplayName({ user_metadata: { first_name: 'Jane', last_name: 'Doe' } })).toBe('Jane Doe');
  });
  it('falls back to the first name from the email', () => {
    expect(getStaffDisplayName({ email: 'jane.doe@example.com', user_metadata: {} })).toBe('Jane');
    expect(firstNameFromEmail('sam_lee+support@example.com')).toBe('Sam');
  });
  it('falls back to Support Team when nothing is known', () => {
    expect(getStaffDisplayName(null)).toBe('Support Team');
    expect(getStaffDisplayName({ email: '__@example.com', user_metadata: {} })).toBe(DEFAULT_STAFF_NAME);
  });
});

describe('applyTemplateVariables', () => {
  const template = 'Hi {{customer_name}},\n\nThanks for ticket {{ticket_number}}.\n\nBest, {{agent_name}} on behalf of the Keepr team.';

  it('fills {{agent_name}} with the staff name', () => {
    const out = applyTemplateVariables(template, { customerName: 'Pat', ticketNumber: 42, agentName: 'Jane Doe' });
    expect(out).toBe('Hi Pat,\n\nThanks for ticket 42.\n\nBest, Jane Doe on behalf of the Keepr team.');
  });

  it('never leaves raw braces when values are missing', () => {
    const out = applyTemplateVariables(template + ' {{unknown_var}}', {});
    expect(out).not.toMatch(/\{\{|\}\}/);
    expect(out).toContain('Hi there,');
    expect(out).toContain('Best, Support Team on behalf');
    expect(out).toContain('Thanks for ticket.');
    // line breaks untouched by the tidy-up
    expect(out.split('\n')).toHaveLength(5);
  });

  it('is case-insensitive and tolerates inner spaces', () => {
    expect(applyTemplateVariables('{{ AGENT_NAME }}', { agentName: 'Jane' })).toBe('Jane');
  });
});

describe('replyBodyForEmail', () => {
  it('keeps the whole text and paragraph breaks', () => {
    const long = 'A'.repeat(250);
    expect(replyBodyForEmail(`${long}\r\n\r\nSecond paragraph\n\n\n\nThird`)).toBe(`${long}\n\nSecond paragraph\n\nThird`);
  });
});

describe('addMessage reply notification', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    rpc.mockReset().mockResolvedValue({ data: { id: 'm1', ticket_id: 't1', message_type: 'reply' }, error: null });
    getUser.mockReset().mockResolvedValue({
      data: { user: { email: 'jane.doe@example.com', user_metadata: {} } },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the full reply with line breaks and the staff name', async () => {
    const body = `${'B'.repeat(300)}\n\nSecond paragraph with \`code\` and <b>tags</b>.`;
    await addMessage('t1', body, 'reply', { subject: 'S', ticket_number: 7, requester_email: 'c@example.com' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.type).toBe('reply');
    expect(payload.replyPreview).toBe(body);
    expect(payload.agentName).toBe('Jane');
  });
});
