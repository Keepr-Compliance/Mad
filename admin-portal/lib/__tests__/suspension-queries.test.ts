/**
 * Account-suspension query + validation tests (BACKLOG-2077).
 *
 * Covers:
 *   - validateReinstateReason: reason is REQUIRED (mirrors the server-side guard
 *     in reinstate_suspended_account; the RPC's has_internal_role gate is enforced
 *     in-DB and exercised via the browser client at runtime — see SuspensionAction).
 *   - getSuspensionStatus: shapes the licenses + account_suspensions reads into a
 *     SuspensionStatus, and never hides a real block behind a missing audit row or
 *     a failed read.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  validateReinstateReason,
  getSuspensionStatus,
  type SuspensionEvent,
} from '../suspension-queries';

// --- validateReinstateReason ----------------------------------------------

describe('validateReinstateReason', () => {
  it('rejects an empty reason', () => {
    const r = validateReinstateReason('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });

  it('rejects a whitespace-only reason', () => {
    const r = validateReinstateReason('   ');
    expect(r.ok).toBe(false);
  });

  it('trims a valid reason', () => {
    const r = validateReinstateReason('  chargeback repaid  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reason).toBe('chargeback repaid');
  });
});

// --- getSuspensionStatus ---------------------------------------------------

/**
 * Minimal chainable stub that returns the queued result for the given table.
 * licenses -> .select().eq().maybeSingle(); account_suspensions ->
 * .select().eq().eq().order().limit().maybeSingle().
 */
function stubClient(results: {
  licenses: { data: { status: string } | null; error: unknown };
  suspensions: { data: SuspensionEvent | null; error: unknown };
}): SupabaseClient {
  const licensesChain = {
    select: () => licensesChain,
    eq: () => licensesChain,
    maybeSingle: () => Promise.resolve(results.licenses),
  };
  const suspensionsChain = {
    select: () => suspensionsChain,
    eq: () => suspensionsChain,
    order: () => suspensionsChain,
    limit: () => suspensionsChain,
    maybeSingle: () => Promise.resolve(results.suspensions),
  };
  return {
    from: (table: string) =>
      table === 'licenses' ? licensesChain : suspensionsChain,
  } as unknown as SupabaseClient;
}

const SAMPLE_EVENT: SuspensionEvent = {
  id: 'evt-1',
  reason: 'Chargeback opened (dispute dp_1)',
  stripe_dispute_id: 'dp_1',
  stripe_payment_intent_id: 'pi_1',
  local_transaction_id: 'TX-1',
  amount_cents: 1499,
  dispute_created_at: '2026-07-18T00:00:00.000Z',
  created_at: '2026-07-18T00:01:00.000Z',
};

describe('getSuspensionStatus', () => {
  it('reports suspended=true with the exact latest event when licenses.status is suspended', async () => {
    const client = stubClient({
      licenses: { data: { status: 'suspended' }, error: null },
      suspensions: { data: SAMPLE_EVENT, error: null },
    });
    const status = await getSuspensionStatus(client, 'USER-1');
    expect(status.isSuspended).toBe(true);
    expect(status.hasError).toBe(false);
    // Identity assertion: the returned event is exactly the queried row.
    expect(status.event).toEqual(SAMPLE_EVENT);
    expect(status.event?.stripe_dispute_id).toBe('dp_1');
  });

  it('reports suspended=false with no event for an active license', async () => {
    const client = stubClient({
      licenses: { data: { status: 'active' }, error: null },
      suspensions: { data: null, error: null },
    });
    const status = await getSuspensionStatus(client, 'USER-2');
    expect(status.isSuspended).toBe(false);
    expect(status.event).toBeNull();
    expect(status.hasError).toBe(false);
  });

  it('still reports suspended=true even if the audit row read is empty (never hide a real block)', async () => {
    const client = stubClient({
      licenses: { data: { status: 'suspended' }, error: null },
      suspensions: { data: null, error: null },
    });
    const status = await getSuspensionStatus(client, 'USER-3');
    expect(status.isSuspended).toBe(true);
    expect(status.event).toBeNull();
  });

  it('flags hasError when a read fails', async () => {
    const client = stubClient({
      licenses: { data: null, error: { message: 'boom' } },
      suspensions: { data: null, error: null },
    });
    const status = await getSuspensionStatus(client, 'USER-4');
    expect(status.hasError).toBe(true);
    // A failed license read must not masquerade as "not suspended" being safe —
    // isSuspended is false here, but hasError=true signals the UI to warn.
    expect(status.isSuspended).toBe(false);
  });
});
