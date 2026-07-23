/**
 * API route: send the Keepr desktop download link to a marketing-site visitor.
 *
 * Gateway endpoint (routed design). The keepr-landing marketing site cannot hold
 * Azure/M365 secrets, so it does a server-to-server POST here; the portal — which
 * already holds the Graph credentials — is the actual sender.
 *
 * Auth: shared secret via `x-api-key` header (DOWNLOAD_LINK_SHARED_SECRET).
 * The email HTML/text content lives HERE (the portal is the sender now).
 *
 * BACKLOG-2193 (Option B / B1 routed): landing → portal gateway → M365 Graph.
 */

import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { sendEmail } from '@/lib/email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Download link constants (kept in sync with keepr-landing/src/lib/site.ts)
// ---------------------------------------------------------------------------

/** Public /download page on the marketing site — OS-detecting redirect. */
const DOWNLOAD_PAGE_URL = 'https://keeprcompliance.com/download';
/** Latest shipped desktop version — bump on release (mirrors landing site.ts). */
const LATEST_VERSION = '2.25.0';

const RELEASE_REPO = 'Keepr-Compliance/keepr-releases';
const assetBase = `https://github.com/${RELEASE_REPO}/releases/download/v${LATEST_VERSION}`;
const downloads = {
  macArm: `${assetBase}/Keepr-${LATEST_VERSION}-arm64.dmg`,
  macIntel: `${assetBase}/Keepr-${LATEST_VERSION}.dmg`,
  windows: `${assetBase}/Keepr-Setup-${LATEST_VERSION}.exe`,
} as const;

// ---------------------------------------------------------------------------
// Lightweight in-memory rate limit (best-effort per-IP abuse guard)
// ---------------------------------------------------------------------------
// Serverless instances are ephemeral/unshared, so this only throttles bursts on
// the same warm instance — a courtesy guard, not a hard limit.

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 5; // max sends per IP per window
const hits = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

// Basic RFC-5322-ish email validation — good enough to reject obvious garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Email content — short, on-brand
// ---------------------------------------------------------------------------

function buildDownloadEmail(): { subject: string; html: string; text: string } {
  const subject = 'Your Keepr download link';

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:#F4F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#191B2E;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F5F9;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FFFFFF;border-radius:14px;padding:36px 34px;">
            <tr>
              <td>
                <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;letter-spacing:-0.01em;color:#191B2E;">Your Keepr download link</h1>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:#40465C;">
                  Keepr runs on your Mac or PC. Open this link on your computer to download and set up — it takes about two minutes.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  <tr>
                    <td style="border-radius:10px;background:#4F46E5;">
                      <a href="${DOWNLOAD_PAGE_URL}" style="display:inline-block;padding:13px 24px;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;">Download Keepr</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#666C82;">
                  Or go straight to the build you need:
                </p>
                <p style="margin:0 0 22px;font-size:13px;line-height:1.7;color:#666C82;">
                  <a href="${downloads.macArm}" style="color:#4F46E5;text-decoration:none;">Mac — Apple Silicon</a><br />
                  <a href="${downloads.macIntel}" style="color:#4F46E5;text-decoration:none;">Mac — Intel</a><br />
                  <a href="${downloads.windows}" style="color:#4F46E5;text-decoration:none;">Windows</a>
                </p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:#9AA0B4;">
                  Keepr v${LATEST_VERSION} · Free to download &amp; set up.<br />
                  You&apos;re getting this because you asked us to email you the download link from keeprcompliance.com.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    'Your Keepr download link',
    '',
    'Keepr runs on your Mac or PC. Open this link on your computer to download and set up — it takes about two minutes.',
    '',
    `Download: ${DOWNLOAD_PAGE_URL}`,
    '',
    'Or go straight to the build you need:',
    `Mac — Apple Silicon: ${downloads.macArm}`,
    `Mac — Intel: ${downloads.macIntel}`,
    `Windows: ${downloads.windows}`,
    '',
    `Keepr v${LATEST_VERSION} · Free to download & set up.`,
    "You're getting this because you asked us to email you the download link from keeprcompliance.com.",
  ].join('\n');

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    // Validate shared secret (landing → portal auth)
    const apiKey = request.headers.get('x-api-key');
    if (
      !process.env.DOWNLOAD_LINK_SHARED_SECRET ||
      apiKey !== process.env.DOWNLOAD_LINK_SHARED_SECRET
    ) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Best-effort per-IP rate limit (x-forwarded-for set by Vercel)
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again in a minute.' },
        { status: 429 },
      );
    }

    let email: unknown;
    try {
      const parsed = (await request.json()) as { email?: unknown };
      email = parsed?.email;
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    if (
      typeof email !== 'string' ||
      !EMAIL_RE.test(email.trim()) ||
      email.length > 320
    ) {
      return NextResponse.json(
        { error: 'Please enter a valid email address.' },
        { status: 400 },
      );
    }

    const recipient = email.trim();

    Sentry.addBreadcrumb({
      category: 'email.route',
      message: 'Processing send-download-link request',
      level: 'info',
      data: { recipient },
    });

    const { subject, html, text } = buildDownloadEmail();
    const result = await sendEmail({
      to: recipient,
      subject,
      html,
      text,
      emailType: 'other',
      logMetadata: { source: 'landing_download_link' },
    });

    if (!result.success) {
      Sentry.captureMessage(`Download-link email failed for ${recipient}`, {
        level: 'warning',
        extra: { error: result.error },
      });
      return NextResponse.json(
        { ok: false, error: result.error || 'Failed to send email.' },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'send-download-link' } });
    console.error('[SendDownloadLink] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
