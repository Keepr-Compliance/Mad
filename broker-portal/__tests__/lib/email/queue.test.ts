/**
 * @jest-environment node
 *
 * Tests for the durable email retry queue (BACKLOG-2009): enqueueEmail + drainEmailQueue.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

const mockSendViaGraph = jest.fn();
const mockLog = jest.fn();

// Mock the low-level Graph send, the not-configured error class and the delivery
// logger (BACKLOG-4011: the drain writes email_delivery_log rows through it).
jest.mock('../../../lib/email/send-email', () => {
  class EmailNotConfiguredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'EmailNotConfiguredError';
    }
  }
  return {
    sendViaGraph: (...args: unknown[]) => mockSendViaGraph(...args),
    logEmailDelivery: (...args: unknown[]) => mockLog(...args),
    EmailNotConfiguredError,
  };
});

// Build a chainable supabase mock. The select-chain resolves to `selectResult`;
// update-chain records the payload passed to .update(...).
const updateCalls: Array<Record<string, unknown>> = [];
const insertCalls: Array<Record<string, unknown>> = [];
let selectResult: { data: unknown[] | null; error: { message: string } | null } = {
  data: [],
  error: null,
};
let insertResult: { error: { message: string } | null } = { error: null };

function makeSelectChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'lte', 'order']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.limit = jest.fn(() => Promise.resolve(selectResult));
  return chain;
}

function makeUpdateChain(payload: Record<string, unknown>) {
  updateCalls.push(payload);
  return { eq: jest.fn(() => Promise.resolve({ error: null })) };
}

const mockFrom = jest.fn(() => ({
  select: (...a: unknown[]) => makeSelectChain().select!(...(a as [])),
  update: (payload: Record<string, unknown>) => makeUpdateChain(payload),
  insert: (payload: Record<string, unknown>) => {
    insertCalls.push(payload);
    return Promise.resolve(insertResult);
  },
}));

jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mockFrom }),
}));

import { enqueueEmail, drainEmailQueue } from '../../../lib/email/queue';

function httpErr(status: number): Error {
  const e = new Error(`HTTP ${status}`) as Error & { statusCode: number };
  e.statusCode = status;
  return e;
}

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    email_type: 'invite',
    recipient_email: 'user@example.com',
    subject: 'S',
    html: '<p>h</p>',
    body_text: 't',
    from_address: null,
    reply_to: null,
    log_metadata: {},
    status: 'enqueued',
    attempts: 0,
    max_attempts: 5,
    next_attempt_at: new Date().toISOString(),
    last_error: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  updateCalls.length = 0;
  insertCalls.length = 0;
  selectResult = { data: [], error: null };
  insertResult = { error: null };
});

describe('enqueueEmail', () => {
  it('inserts a row and returns true', async () => {
    const ok = await enqueueEmail({
      emailType: 'invite',
      recipientEmail: 'user@example.com',
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
    });
    expect(ok).toBe(true);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      email_type: 'invite',
      recipient_email: 'user@example.com',
      body_text: 't',
      status: 'enqueued',
      attempts: 0,
    });
  });

  it('returns false when the insert errors', async () => {
    insertResult = { error: { message: 'db down' } };
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const ok = await enqueueEmail({
      emailType: 'invite',
      recipientEmail: 'user@example.com',
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
    });
    expect(ok).toBe(false);
    consoleSpy.mockRestore();
  });
});

describe('drainEmailQueue', () => {
  it('marks a row sent on a successful re-send', async () => {
    selectResult = { data: [queueRow()], error: null };
    mockSendViaGraph.mockResolvedValueOnce(undefined);

    const result = await drainEmailQueue();

    expect(result).toMatchObject({ scanned: 1, sent: 1, retryScheduled: 0, deadLettered: 0 });
    expect(updateCalls[0]).toMatchObject({ status: 'sent' });
  });

  // BACKLOG-4011: the first attempt logged 'queued'; a successful retry logs 'sent'
  // with the same metadata the first-send row carries (subject + logMetadata).
  it("writes a 'sent' email_delivery_log row on a successful re-send", async () => {
    const logMetadata = { subject: 'Your receipt', paymentReference: 'pi_test_4011' };
    selectResult = {
      data: [queueRow({ email_type: 'receipt', attempts: 2, log_metadata: logMetadata })],
      error: null,
    };
    mockSendViaGraph.mockResolvedValueOnce(undefined);

    await drainEmailQueue();

    expect(mockLog).toHaveBeenCalledTimes(1);
    const arg = mockLog.mock.calls[0][0];
    expect(arg).toMatchObject({
      emailType: 'receipt',
      recipientEmail: 'user@example.com',
      status: 'sent',
    });
    expect(arg.metadata).toEqual({ ...logMetadata, retriedFromQueue: true, queueAttempt: 3 });
  });

  it('reschedules with backoff on a transient failure below max_attempts', async () => {
    selectResult = { data: [queueRow({ attempts: 1, max_attempts: 5 })], error: null };
    mockSendViaGraph.mockRejectedValueOnce(httpErr(503));

    const result = await drainEmailQueue();

    expect(result.retryScheduled).toBe(1);
    expect(result.deadLettered).toBe(0);
    const upd = updateCalls[0];
    expect(upd.attempts).toBe(2);
    expect(upd.next_attempt_at).toBeDefined();
    expect(upd.status).toBeUndefined(); // stays 'enqueued'
    // BACKLOG-4011: nothing is logged until the row is delivered or dead-lettered,
    // and the drain never re-enqueues (it must not route through sendEmail()).
    expect(mockLog).not.toHaveBeenCalled();
    expect(insertCalls).toHaveLength(0);
  });

  it('dead-letters on the final transient attempt (attempts+1 >= max)', async () => {
    selectResult = { data: [queueRow({ attempts: 4, max_attempts: 5 })], error: null };
    mockSendViaGraph.mockRejectedValueOnce(httpErr(500));

    const result = await drainEmailQueue();

    expect(result.deadLettered).toBe(1);
    expect(updateCalls[0]).toMatchObject({ status: 'failed', attempts: 5 });
    // BACKLOG-4011 (founder ruling): a dead-lettered retry writes a 'failed' log row.
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0]).toMatchObject({
      emailType: 'invite',
      recipientEmail: 'user@example.com',
      status: 'failed',
      errorMessage: 'HTTP 500',
    });
  });

  it('dead-letters immediately on a permanent (4xx) failure', async () => {
    selectResult = { data: [queueRow({ attempts: 0, max_attempts: 5 })], error: null };
    mockSendViaGraph.mockRejectedValueOnce(httpErr(400));

    const result = await drainEmailQueue();

    expect(result.deadLettered).toBe(1);
    expect(updateCalls[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(mockLog).toHaveBeenCalledTimes(1);
    expect(mockLog.mock.calls[0][0]).toMatchObject({ status: 'failed', errorMessage: 'HTTP 400' });
  });

  it('returns an empty summary when the query errors', async () => {
    selectResult = { data: null, error: { message: 'boom' } };
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const result = await drainEmailQueue();

    expect(result).toEqual({ scanned: 0, sent: 0, retryScheduled: 0, deadLettered: 0 });
    consoleSpy.mockRestore();
  });
});
