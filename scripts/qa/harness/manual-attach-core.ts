/**
 * MANUAL-ATTACH exact-count cell — shared core (BACKLOG-1979).
 *
 * Side-effecting helper shared by the Playwright spec (e2e/tests/manual-attach-email.spec.ts) and
 * unit-testable in isolation. It OBSERVES the encrypted DB (verify-by-observing, BACKLOG-1875) to
 * count how many emails a transaction has linked with a SPECIFIC link_source (e.g. 'manual') — the
 * ground truth that the MANUAL attach flow (transactions:link-emails → createCommunication with
 * link_source='manual') really ran, distinct from the on-open AUTO-link.
 *
 * It reuses the exact ABI + keychain-free contract of filter-toggle-core.countLinkedEmails: the cipher
 * open runs in the dedicated count-linked-by-source.js reader under `ELECTRON_RUN_AS_NODE=1 electron`
 * (headless), NOT the ts-node parent; args are passed via argv (no shell) so nothing is interpolated.
 *
 * PURE-NODE at import (no Playwright/Electron/DOM) so it is type-checked by the harness tsconfig and
 * usable from both the spec and a plain-node context.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const LINKED_BY_SOURCE_SENTINEL = '__QA_LINKED_BY_SOURCE__ ';

/** A link_source value from the schema CHECK constraint. */
export type LinkSource = 'auto' | 'manual' | 'scan';

export interface CountLinkedBySourceOpts {
  /** Restrict to a single link_source (e.g. 'manual'). Omit to count any source. */
  linkSource?: LinkSource;
  /** Restrict to a single email id (prove ONE specific email is linked). Omit to count all. */
  emailId?: string;
}

/**
 * OBSERVE the DISTINCT linked-email count for a transaction, optionally filtered by link_source and/or
 * a single email id. Throws (→ HARNESS_ERROR upstream) on any launch/decrypt/parse failure so a missing
 * reader can never be silently read as "0 linked" (a false FAIL). Returns the count.
 */
export function countLinkedEmailsBySource(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
  opts: CountLinkedBySourceOpts = {},
): number {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'count-linked-by-source.js');
  const args = [script, '--db', dbPath, '--key', dbKey, '--transaction-id', transactionId];
  if (opts.linkSource !== undefined) args.push('--link-source', opts.linkSource);
  if (opts.emailId !== undefined) args.push('--email-id', opts.emailId);
  const run = spawnSync(electronBin, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (run.error) throw new Error(`count-linked-by-source failed to launch: ${run.error.message}`);
  const line = (run.stdout || '').split('\n').find((l) => l.includes(LINKED_BY_SOURCE_SENTINEL));
  if (!line) {
    throw new Error(
      `count-linked-by-source produced no result (exit ${run.status ?? 'null'}).\n${run.stderr ?? ''}`,
    );
  }
  const parsed = JSON.parse(
    line.slice(line.indexOf(LINKED_BY_SOURCE_SENTINEL) + LINKED_BY_SOURCE_SENTINEL.length),
  ) as { n?: number; error?: string };
  if (parsed.error) throw new Error(`count-linked-by-source error: ${parsed.error}`);
  return parsed.n ?? 0;
}
