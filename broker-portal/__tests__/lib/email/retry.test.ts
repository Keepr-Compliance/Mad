/**
 * @jest-environment node
 *
 * Unit tests for email retry classification + backoff (BACKLOG-2009).
 */

import {
  getErrorStatus,
  isTransientError,
  backoffDelayMs,
} from '../../../lib/email/retry';

describe('getErrorStatus', () => {
  it('reads statusCode', () => {
    expect(getErrorStatus({ statusCode: 503 })).toBe(503);
  });
  it('reads status', () => {
    expect(getErrorStatus({ status: 429 })).toBe(429);
  });
  it('reads numeric string code', () => {
    expect(getErrorStatus({ code: '500' })).toBe(500);
  });
  it('returns null for non-numeric', () => {
    expect(getErrorStatus(new Error('boom'))).toBeNull();
    expect(getErrorStatus(null)).toBeNull();
    expect(getErrorStatus('nope')).toBeNull();
  });
});

describe('isTransientError', () => {
  it('treats 429/408/5xx as transient', () => {
    expect(isTransientError({ statusCode: 429 })).toBe(true);
    expect(isTransientError({ statusCode: 408 })).toBe(true);
    expect(isTransientError({ statusCode: 500 })).toBe(true);
    expect(isTransientError({ statusCode: 503 })).toBe(true);
  });
  it('treats no-status (network) errors as transient', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
  });
  it('treats 4xx (except 408/429) as permanent', () => {
    expect(isTransientError({ statusCode: 400 })).toBe(false);
    expect(isTransientError({ statusCode: 401 })).toBe(false);
    expect(isTransientError({ statusCode: 403 })).toBe(false);
    expect(isTransientError({ statusCode: 404 })).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially from base', () => {
    expect(backoffDelayMs(0, { baseMs: 1000 })).toBe(1000);
    expect(backoffDelayMs(1, { baseMs: 1000 })).toBe(2000);
    expect(backoffDelayMs(2, { baseMs: 1000 })).toBe(4000);
  });
  it('caps at maxMs', () => {
    expect(backoffDelayMs(20, { baseMs: 1000, maxMs: 5000 })).toBe(5000);
  });
});
