/**
 * @jest-environment node
 *
 * Tests for the download-invite email template (BACKLOG-1914).
 *
 * The individual (no-org) invite is now a branded "Get Keepr" download email
 * instead of the dead individual_invitations token link. These tests assert the
 * CTA points at the canonical download page (exact href identity, not a
 * substring count) and that the template is email-client-safe.
 */

import {
  buildDownloadInviteEmail,
  DEFAULT_DOWNLOAD_URL,
} from '../../../lib/email/templates/download-invite';

describe('buildDownloadInviteEmail', () => {
  it('uses the canonical keeprcompliance.com download URL by default', () => {
    expect(DEFAULT_DOWNLOAD_URL).toBe('https://keeprcompliance.com');
    const result = buildDownloadInviteEmail({ recipientEmail: 'user@example.com' });
    expect(result.text).toContain(`Get Keepr: ${DEFAULT_DOWNLOAD_URL}`);
  });

  it('renders the "Get Keepr" CTA button with the download URL as its href', () => {
    const result = buildDownloadInviteEmail({ recipientEmail: 'user@example.com' });

    // Identity assertion: the CTA anchor's href is exactly the download URL.
    const ctaMatch = result.html.match(
      /<a\s+href="([^"]+)"[^>]*>\s*Get Keepr\s*<\/a>/,
    );
    expect(ctaMatch).not.toBeNull();
    expect(ctaMatch?.[1]).toBe(DEFAULT_DOWNLOAD_URL);
  });

  it('honours an explicit download URL override in both the CTA and plain text', () => {
    const url = 'https://download.keepr.example/app';
    const result = buildDownloadInviteEmail({
      recipientEmail: 'user@example.com',
      downloadUrl: url,
    });

    const ctaMatch = result.html.match(/<a\s+href="([^"]+)"[^>]*>\s*Get Keepr\s*<\/a>/);
    expect(ctaMatch?.[1]).toBe(url);
    expect(result.text).toContain(`Get Keepr: ${url}`);
  });

  it('has the expected subject and includes a plain-text fallback link', () => {
    const result = buildDownloadInviteEmail({ recipientEmail: 'user@example.com' });
    expect(result.subject).toBe("You've been invited to Keepr");
    // Plain-text fallback carries the URL for clients that strip HTML.
    expect(result.text).toContain(DEFAULT_DOWNLOAD_URL);
  });

  it('uses inline CSS only (no <style> tags) for email-client safety', () => {
    const result = buildDownloadInviteEmail({ recipientEmail: 'user@example.com' });
    expect(result.html).not.toMatch(/<style[\s>]/);
  });

  it('escapes a hostile download URL in the href (no attribute breakout)', () => {
    const result = buildDownloadInviteEmail({
      recipientEmail: 'user@example.com',
      downloadUrl: 'https://evil.example/"onmouseover="x',
    });
    // The raw double-quote must be entity-encoded so it can't break out of href.
    expect(result.html).not.toContain('"onmouseover="x');
    expect(result.html).toContain('&quot;onmouseover=&quot;x');
  });
});
