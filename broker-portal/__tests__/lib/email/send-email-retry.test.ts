/**
 * @jest-environment node
 *
 * Tests for the retry + enqueue behaviour added in BACKLOG-2009.
 *
 * Covers:
 * - transient failure (5xx/429/network) retried in-request, then succeeds
 * - transient failure that exhausts retries -> enqueued (outcome 'queued')
 * - permanent failure (4xx) -> NOT retried, NOT enqueued (outcome 'failed')
 * - missing config -> outcome 'skipped', never enqueued
 * - enqueue failure -> falls back to outcome 'failed'
 */

/* eslint-disable @typescript-eslint/no-require-imports */

const mockPost = jest.fn();
const mockApi = jest.fn(() => ({ post: mockPost }));
const mockEnqueue = jest.fn();
const mockInsert = jest.fn().mockResolvedValue({ error: null });

jest.mock('@azure/identity', () => ({ ClientSecretCredential: jest.fn() }));
jest.mock('@microsoft/microsoft-graph-client', () => ({
  Client: { initWithMiddleware: jest.fn(() => ({ api: mockApi })) },
}));
jest.mock(
  '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials',
  () => ({ TokenCredentialAuthenticationProvider: jest.fn() }),
);

// Service client -> only used for the fire-and-forget delivery log insert.
jest.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => ({ insert: mockInsert }) }),
}));

// Queue module mocked so we assert enqueue calls without a DB.
jest.mock('../../../lib/email/queue', () => ({
  enqueueEmail: (...args: unknown[]) => mockEnqueue(...args),
}));

// Make backoff instantaneous.
jest.mock('../../../lib/email/retry', () => {
  const actual = jest.requireActual('../../../lib/email/retry');
  return { ...actual, sleep: jest.fn().mockResolvedValue(undefined) };
});

import { sendEmail } from '../../../lib/email/send-email';
import { resetGraphClient } from '../../../lib/email/graph-client';

const ORIGINAL_ENV = process.env;

function httpErr(status: number): Error {
  const e = new Error(`HTTP ${status}`) as Error & { statusCode: number };
  e.statusCode = status;
  return e;
}

const baseParams = {
  to: 'user@example.com',
  subject: 'Test',
  html: '<p>Hi</p>',
  text: 'Hi',
  emailType: 'invite' as const,
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
  mockEnqueue.mockResolvedValue(true);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('sendEmail retry/queue (BACKLOG-2009)', () => {
  it('retries a transient 5xx in-request and succeeds', async () => {
    mockPost
      .mockRejectedValueOnce(httpErr(503))
      .mockResolvedValueOnce(undefined);

    const result = await sendEmail(baseParams);

    expect(result).toEqual({ success: true, outcome: 'sent' });
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('enqueues when transient failures exhaust in-request retries', async () => {
    // 3 attempts (2 backoffs) all fail transiently.
    mockPost.mockRejectedValue(httpErr(429));

    const result = await sendEmail(baseParams);

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('queued');
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ emailType: 'invite', recipientEmail: 'user@example.com' }),
    );
  });

  it('treats a network error (no status) as transient and enqueues', async () => {
    mockPost.mockRejectedValue(new Error('ECONNRESET'));

    const result = await sendEmail(baseParams);

    expect(result.outcome).toBe('queued');
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry or enqueue a permanent 4xx failure', async () => {
    mockPost.mockRejectedValue(httpErr(400));

    const result = await sendEmail(baseParams);

    expect(result.success).toBe(false);
    expect(result.outcome).toBe('failed');
    expect(mockPost).toHaveBeenCalledTimes(1); // no retry
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('returns skipped (never enqueues) when creds are missing', async () => {
    resetGraphClient();
    process.env.AZURE_TENANT_ID = undefined;
    process.env.AZURE_CLIENT_ID = undefined;
    process.env.AZURE_CLIENT_SECRET = undefined;

    const result = await sendEmail(baseParams);

    expect(result.outcome).toBe('skipped');
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('falls back to failed when enqueue itself fails', async () => {
    mockPost.mockRejectedValue(httpErr(500));
    mockEnqueue.mockResolvedValue(false);

    const result = await sendEmail(baseParams);

    expect(result.outcome).toBe('failed');
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});
