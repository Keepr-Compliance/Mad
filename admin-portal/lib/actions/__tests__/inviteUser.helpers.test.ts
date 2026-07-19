/**
 * Tests for the inviteUser pure helpers (BACKLOG-1914).
 *
 * Covers the flow resolution + download-invite payload shaping that decides
 * whether an invite goes down the org RPC path or the individual download-email
 * path. The server action itself (Supabase + Next server) is exercised at
 * runtime; these tests pin the pure decision/shaping logic.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidEmail,
  resolveInviteFlow,
  buildDownloadInvitePayload,
  DEFAULT_DOWNLOAD_URL,
} from '../inviteUser.helpers';

describe('resolveInviteFlow', () => {
  it('routes to the org path when an organization id is present', () => {
    expect(resolveInviteFlow('00000000-0000-0000-0000-000000000001')).toBe('org');
  });

  it('routes to the download path when organizationId is null', () => {
    expect(resolveInviteFlow(null)).toBe('download');
  });

  it('routes to the download path when organizationId is undefined', () => {
    expect(resolveInviteFlow(undefined)).toBe('download');
  });

  it('routes to the download path for an empty-string organizationId', () => {
    expect(resolveInviteFlow('')).toBe('download');
  });
});

describe('buildDownloadInvitePayload', () => {
  it('defaults to the canonical keeprcompliance.com download URL', () => {
    const payload = buildDownloadInvitePayload('user@example.com');
    expect(payload.downloadUrl).toBe(DEFAULT_DOWNLOAD_URL);
    expect(DEFAULT_DOWNLOAD_URL).toBe('https://keeprcompliance.com');
  });

  it('normalises the recipient email (lowercase + trim)', () => {
    const payload = buildDownloadInvitePayload('  User@Example.COM  ');
    expect(payload.recipientEmail).toBe('user@example.com');
  });

  it('honours an explicit download URL override', () => {
    const payload = buildDownloadInvitePayload('user@example.com', 'https://download.example');
    expect(payload.downloadUrl).toBe('https://download.example');
  });

  it('falls back to the default when the override is blank/whitespace', () => {
    expect(buildDownloadInvitePayload('user@example.com', '   ').downloadUrl).toBe(DEFAULT_DOWNLOAD_URL);
    expect(buildDownloadInvitePayload('user@example.com', null).downloadUrl).toBe(DEFAULT_DOWNLOAD_URL);
  });
});

describe('isValidEmail', () => {
  it('accepts well-formed addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('user.name+tag@sub.domain.co')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('missing@domain')).toBe(false);
    expect(isValidEmail('spaces in@email.com')).toBe(false);
  });
});
