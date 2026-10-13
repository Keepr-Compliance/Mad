/**
 * @jest-environment node
 *
 * BACKLOG-3849 — J13: every billing outbox kind ships with a convergence test.
 *
 * SR R7: a handler must converge (re-running it leaves the same state), because
 * Stripe's idempotency key only covers about 24 hours. Each key in
 * OUTBOX_HANDLERS therefore needs
 *   __tests__/lib/billing/outboxKinds/<kind>.convergence.test.ts
 *
 * EXPECTED_KINDS is the reviewed list. It is empty in BACKLOG-3849, which ships
 * the drain with no kinds. The producer slice that adds a kind adds it here in
 * the same PR, together with its convergence test; adding a kind to the
 * registry alone turns this suite red.
 */

import fs from 'fs';
import path from 'path';
import { OUTBOX_HANDLERS } from '@/lib/billing/outboxKinds';

const EXPECTED_KINDS: string[] = ['agent_end_now_cancel', 'agent_receipt']; // BACKLOG-3848
const DIR = path.join(__dirname, 'outboxKinds');

function missingConvergenceTests(kinds: string[], dir: string): string[] {
  return kinds.filter((k) => !fs.existsSync(path.join(dir, `${k}.convergence.test.ts`)));
}

describe('J13 outbox handler contract', () => {
  const kinds = Object.keys(OUTBOX_HANDLERS).sort();

  it('the registry holds exactly the reviewed kinds', () => {
    expect(kinds).toEqual([...EXPECTED_KINDS].sort());
  });

  it('every registered kind has a convergence test', () => {
    expect(missingConvergenceTests(kinds, DIR)).toEqual([]);
  });

  it('the check sees a kind with no test file (control on the checker itself)', () => {
    expect(missingConvergenceTests(['kind_without_a_test_3849'], DIR)).toEqual(['kind_without_a_test_3849']);
  });

  it('the registry cannot be changed at run time', () => {
    expect(Object.isFrozen(OUTBOX_HANDLERS)).toBe(true);
  });
});
