/**
 * One log line per consent / AI apps page render or action (BACKLOG-4238).
 *
 * Outcomes are fixed strings. A failed database call adds its error code only
 * (SQLSTATE or PGRSTnnn shape, else 'none'); never the message or any value.
 */

import { dbCode, logOutcome } from '@/lib/mcp/oauth/log';

export function logAccount(
  route: 'consent' | 'ai-apps',
  outcome: string,
  status: number,
  started: number,
  failure?: { code: unknown }
): void {
  logOutcome({
    route,
    outcome,
    status,
    ms: Date.now() - started,
    ...(failure ? { error: dbCode(failure.code) } : {}),
  });
}
