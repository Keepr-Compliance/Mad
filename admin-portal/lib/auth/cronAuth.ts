/**
 * Authorization for Vercel Cron routes (BACKLOG-3928).
 *
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the project has
 * CRON_SECRET configured. A route accepts the request only when:
 *   - CRON_SECRET is configured and non-empty (fail closed otherwise), and
 *   - the header equals `Bearer <CRON_SECRET>` exactly (constant-time compare).
 *
 * broker-portal keeps its own copy (broker-portal/lib/auth/cronAuth.ts); the
 * portals do not import from each other.
 */

import { timingSafeEqual } from 'crypto';

export function isAuthorizedCronRequest(
  authHeader: string | null,
  secret: string | undefined = process.env.CRON_SECRET
): boolean {
  if (!secret) return false;
  if (!authHeader) return false;

  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  const received = Buffer.from(authHeader, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
