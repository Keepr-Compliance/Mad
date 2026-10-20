/**
 * @jest-environment node
 *
 * BACKLOG-4001: a refused email_delivery_log insert is reported, not swallowed.
 *
 * supabase-js does not throw when PostgREST refuses an insert; it resolves with
 * { error }. Before 4001 logEmailDelivery awaited the insert and never read it, so a
 * check-constraint refusal (23514) left no row and no signal. The error fixture is the
 * shape PostgREST returns for a check violation: `details` carries the failing row,
 * recipient included, so nothing from message/details/hint may reach Sentry.
 */

const mockPost = jest.fn();
const mockApi = jest.fn(() => ({ post: mockPost }));
const mockInsert = jest.fn();
const mockCaptureMessage = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
jest.mock('@azure/identity', () => ({ ClientSecretCredential: jest.fn() }));
jest.mock('@microsoft/microsoft-graph-client', () => ({
  Client: { initWithMiddleware: jest.fn(() => ({ api: mockApi })) },
}));
jest.mock(
  '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials',
  () => ({ TokenCredentialAuthenticationProvider: jest.fn() }),
);
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => ({ insert: mockInsert }) }),
}));
jest.mock('../../../lib/email/queue', () => ({ enqueueEmail: jest.fn() }));

import { sendEmail } from '../../../lib/email/send-email';
import { resetGraphClient } from '../../../lib/email/graph-client';

const RECIPIENT = 'billing-contact@example.com';
const ORIGINAL_ENV = process.env;

const checkViolation = {
  code: '23514',
  message: 'new row for relation "email_delivery_log" violates check constraint "email_delivery_log_email_type_check"',
  details: `Failing row contains (5d0c…, receipt, ${RECIPIENT}, sent, null, {"subject": "Your Keepr receipt"}, 2026-10-19 …).`,
  hint: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  resetGraphClient();
  process.env = {
    ...ORIGINAL_ENV,
    AZURE_TENANT_ID: 'test-tenant',
    AZURE_CLIENT_ID: 'test-client',
    AZURE_CLIENT_SECRET: 'test-secret',
    EMAIL_SENDER_ADDRESS: 'noreply@test.com',
  };
  mockPost.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const send = () =>
  sendEmail({ to: RECIPIENT, subject: 'Your Keepr receipt', html: '<p>x</p>', text: 'x', emailType: 'receipt' });

describe('logEmailDelivery reports a refused insert (BACKLOG-4001)', () => {
  it('reports a resolved {error} to Sentry once, tagged with type and status; the send still succeeds', async () => {
    mockInsert.mockResolvedValue({ data: null, error: checkViolation });

    const result = await send();

    expect(result).toEqual({ success: true, outcome: 'sent' });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [msg, ctx] = mockCaptureMessage.mock.calls[0];
    expect(msg).toBe('email_delivery_log insert refused');
    expect(ctx).toEqual({
      level: 'error',
      tags: { email_type: 'receipt', email_log_status: 'sent' },
      extra: { code: '23514' },
    });
  });

  it('sends nothing from the error text or the row to Sentry or the console', async () => {
    mockInsert.mockResolvedValue({ data: null, error: checkViolation });

    await send();

    const sentry = JSON.stringify([mockCaptureMessage.mock.calls, mockCaptureException.mock.calls]);
    const consoleOut = JSON.stringify((console.error as jest.Mock).mock.calls);
    for (const out of [sentry, consoleOut]) {
      expect(out).not.toContain(RECIPIENT);
      expect(out).not.toContain('Failing row');
      expect(out).not.toContain('Your Keepr receipt');
    }
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the insert succeeds', async () => {
    mockInsert.mockResolvedValue({ data: null, error: null });

    await send();

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('reports a thrown logging failure too, without the error text', async () => {
    mockInsert.mockRejectedValue(new Error(`socket closed while writing ${RECIPIENT}`));

    const result = await send();

    expect(result).toEqual({ success: true, outcome: 'sent' });
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage.mock.calls[0][0]).toBe('email_delivery_log insert threw');
    expect(mockCaptureMessage.mock.calls[0][1]).toEqual({
      level: 'error',
      tags: { email_type: 'receipt', email_log_status: 'sent' },
    });
    expect(JSON.stringify(mockCaptureMessage.mock.calls)).not.toContain(RECIPIENT);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(RECIPIENT);
  });
});
