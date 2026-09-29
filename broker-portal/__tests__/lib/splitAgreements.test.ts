/**
 * splitAgreements.ts — BACKLOG-3504.
 *
 * Imports the REAL functions rather than re-implementing their logic inline
 * (unlike updateUserRole.test.ts's convention) — a copy in the test file can
 * drift from the code it is supposed to be proving; importing the module
 * means a real change here shows up as a real test result.
 */

import {
  splitAppliesToRole,
  canViewSplit,
  canEditSplit,
  deriveCurrentSplit,
  formatEffectiveDate,
  resolveSplitListDisplay,
  getSplitHistory,
  getCurrentSplitsForOrg,
  type SplitAgreementRow,
} from '@/lib/splitAgreements';
import type { Role } from '@/lib/types/users';
import { createScopedClient } from '@/lib/scoped-client';

// ============================================================================
// Role gates
// ============================================================================

describe('splitAppliesToRole', () => {
  it.each<[Role, boolean]>([
    ['agent', true],
    ['broker', true],
    ['admin', false],
    ['it_admin', false],
  ])('%s -> %s', (role, expected) => {
    expect(splitAppliesToRole(role)).toBe(expected);
  });
});

describe('canViewSplit / canEditSplit', () => {
  it.each<[Role, boolean]>([
    ['admin', true],
    ['broker', true],
    ['agent', false],
    ['it_admin', false],
  ])('%s -> %s (it_admin excluded, per founder ruling — may not even read)', (role, expected) => {
    expect(canViewSplit(role)).toBe(expected);
    expect(canEditSplit(role)).toBe(expected);
  });
});

// ============================================================================
// deriveCurrentSplit — the ordering contract itself
// ============================================================================

function row(overrides: Partial<SplitAgreementRow>): SplitAgreementRow {
  return {
    id: 'row-id',
    seq: 1,
    organization_id: 'org-1',
    agent_user_id: 'agent-1',
    agent_pct: 50,
    brokerage_pct: 50,
    effective_from: '2026-01-01',
    note: null,
    set_by: 'setter-1',
    set_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('deriveCurrentSplit', () => {
  it('returns null for an empty history', () => {
    expect(deriveCurrentSplit([])).toBeNull();
  });

  it('picks the first row already in force as of the given date', () => {
    // Pre-ordered exactly as getSplitHistory returns: effective_from DESC, seq DESC.
    const history = [
      row({ id: 'jan-2026', effective_from: '2026-01-01', agent_pct: 70 }),
      row({ id: 'jul-2025', effective_from: '2025-07-01', agent_pct: 68 }),
      row({ id: 'jan-2025', effective_from: '2025-01-01', agent_pct: 65 }),
    ];
    expect(deriveCurrentSplit(history, '2026-06-01')?.id).toBe('jan-2026');
    expect(deriveCurrentSplit(history, '2025-09-01')?.id).toBe('jul-2025');
    expect(deriveCurrentSplit(history, '2025-01-01')?.id).toBe('jan-2025');
  });

  it('the boundary is inclusive: a row effective TODAY counts as current today', () => {
    const history = [row({ id: 'today', effective_from: '2026-06-15' })];
    expect(deriveCurrentSplit(history, '2026-06-15')?.id).toBe('today');
  });

  it('skips a future-dated row and falls through to the one actually in force', () => {
    const history = [
      row({ id: 'future', effective_from: '2027-01-01' }),
      row({ id: 'current', effective_from: '2026-01-01' }),
    ];
    expect(deriveCurrentSplit(history, '2026-06-01')?.id).toBe('current');
  });

  it('returns null when every row is future-dated', () => {
    const history = [row({ id: 'future', effective_from: '2099-01-01' })];
    expect(deriveCurrentSplit(history, '2026-06-01')).toBeNull();
  });

  it('CONTROL: reverting the boundary to strict-less-than reds the inclusive-boundary case', () => {
    // Mirrors the mutant the migration's own header calls out for
    // split_agreement_in_force() (m41: `<` in place of `<=`). Proves the test
    // above is load-bearing rather than vacuous.
    function deriveWithStrictLessThan(rows: readonly SplitAgreementRow[], asOfDate: string) {
      for (const r of rows) {
        if (r.effective_from < asOfDate) return r; // MUTATED: was <=
      }
      return null;
    }
    const history = [row({ id: 'today', effective_from: '2026-06-15' })];
    expect(deriveWithStrictLessThan(history, '2026-06-15')).toBeNull(); // red vs. the real function's not-null
    expect(deriveCurrentSplit(history, '2026-06-15')).not.toBeNull();
  });
});

// ============================================================================
// formatEffectiveDate — the UTC-vs-local-calendar-day regression
// ============================================================================

describe('formatEffectiveDate', () => {
  it('illustrates the bug this guards against, deterministically on any host', () => {
    // Parsing a date-only ISO string with new Date() reads it as UTC
    // midnight, which a negative-UTC-offset zone then renders as the
    // PREVIOUS calendar day.
    //
    // `timeZone` is passed explicitly to Intl.DateTimeFormat rather than
    // relying on process.env.TZ (an earlier version of this test set
    // process.env.TZ = 'America/Los_Angeles' at module load and asserted the
    // shift). THAT WAS ITSELF TIMEZONE-DEPENDENT AND WRONG: it passed
    // wherever the host happened to already sit behind UTC (it did, by
    // coincidence, on the two machines that ran it locally) and reproduced
    // the exact false-red-against-correct-code shape this repo's own
    // doctrine warns about the moment CI (UTC) ran it — under UTC, the naive
    // reading IS "Jan 1, 2026", not "Dec 31, 2025", so the old assertion
    // failed even though the product code was, and is, correct. Root cause:
    // process.env.TZ mutated inside a test file is not reliably honored by
    // V8/ICU once ANY Date/Intl object has been constructed earlier in that
    // same jest worker process (by an unrelated test file sharing the
    // worker) — exactly the kind of cross-environment hazard a control must
    // not carry. `timeZone` as an explicit Intl option has no such
    // dependency: it is read per call, not from process-wide state, so this
    // now produces the same answer on every runner (empirically checked
    // under TZ=UTC, America/Los_Angeles, Pacific/Kiritimati and Asia/Kolkata).
    const naive = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'America/Los_Angeles',
    }).format(new Date('2026-01-01'));
    expect(naive).toBe('Dec 31, 2025'); // the bug, reproduced — deterministic on any host
  });

  it('is correct at a month boundary too', () => {
    expect(formatEffectiveDate('2026-03-01')).toBe('Mar 1, 2026');
  });

  it('CONTROL: builds the Date from calendar components, never from the raw ISO string', () => {
    // The black-box output assertions above (and formatEffectiveDate's own
    // fix) are, on a UTC host, BYTE-IDENTICAL to what the naive
    // `new Date(isoDate)` implementation would produce: UTC midnight IS the
    // local calendar day when the local zone IS UTC, so there is no offset
    // for the bug to manifest across. That means no assertion on
    // formatEffectiveDate's OUTPUT can distinguish the naive implementation
    // from the fixed one when this suite runs on a UTC CI runner — the
    // literal-comparison tests above pass under either implementation there,
    // which is exactly the false-confidence shape this whole fix exists to
    // avoid repeating. This test does not compare output: it inspects HOW
    // the Date is constructed, which is where the fix actually lives and
    // the one thing that differs regardless of host timezone.
    const OriginalDate = global.Date;
    const calls: unknown[][] = [];
    class SpyDate extends OriginalDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        super(...args);
        calls.push(args);
      }
    }
    // @ts-expect-error -- stubbing the global constructor for this test only
    global.Date = SpyDate;
    try {
      formatEffectiveDate('2026-01-01');
    } finally {
      global.Date = OriginalDate;
    }

    expect(calls).toHaveLength(1);
    // y, m - 1, d as separate numbers — NEVER the raw "2026-01-01" string.
    expect(calls[0]).toEqual([2026, 0, 1]);
  });
});

// ============================================================================
// resolveSplitListDisplay — the Users list column's four states
// ============================================================================

describe('resolveSplitListDisplay', () => {
  it('a pending invite (no user_id) is not-applicable/pending', () => {
    const d = resolveSplitListDisplay({ role: 'agent', user_id: null }, undefined);
    expect(d).toEqual({ kind: 'not-applicable', reason: 'pending' });
  });

  it.each<Role>(['admin', 'it_admin'])('%s subject is not-applicable/role, even with a current row', (roleValue) => {
    const d = resolveSplitListDisplay(
      { role: roleValue, user_id: 'u1' },
      { agent_pct: 60, brokerage_pct: 40 }
    );
    expect(d).toEqual({ kind: 'not-applicable', reason: 'role' });
  });

  it.each<Role>(['agent', 'broker'])('%s subject with no row on file is no-agreement', (roleValue) => {
    const d = resolveSplitListDisplay({ role: roleValue, user_id: 'u1' }, undefined);
    expect(d).toEqual({ kind: 'no-agreement' });
  });

  it.each<Role>(['agent', 'broker'])('%s subject with a current row shows the split', (roleValue) => {
    const d = resolveSplitListDisplay(
      { role: roleValue, user_id: 'u1' },
      { agent_pct: 70, brokerage_pct: 30 }
    );
    expect(d).toEqual({ kind: 'split', agentPct: 70, brokeragePct: 30 });
  });
});

// ============================================================================
// getSplitHistory / getCurrentSplitsForOrg — query shape against a mocked client
// ============================================================================

/** Minimal chainable query stub: every method returns itself; awaiting it
 *  resolves the fixed terminal result — same "thenable" trick as the
 *  org-settings fixtures' makeQuery(), written locally since this module's
 *  call shape (order().order(), no eq() chain needed by the caller here for
 *  getCurrentSplitsForOrg) differs from that fixture's. */
function makeChain(result: { data: unknown; error: unknown }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) {
    chain[m] = jest.fn((...args: unknown[]) => {
      calls.push({ method: m, args });
      return chain;
    });
  }
  (chain as { then: unknown }).then = (
    res: (v: typeof result) => unknown,
    rej?: (e: unknown) => unknown
  ) => Promise.resolve(result).then(res, rej);
  return { chain, calls };
}

function makeClient(result: { data: unknown; error: unknown }) {
  const { chain, calls } = makeChain(result);
  const from = jest.fn(() => chain);
  return { client: { from } as never, calls, from };
}

describe('getSplitHistory', () => {
  it('selects the exact post-trim column set plus the transcribed setter join', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await getSplitHistory(client, 'org-1', 'agent-1');

    const select = calls.find((c) => c.method === 'select');
    // Transcribed from the migration's FK name
    // (agent_split_agreements_set_by_fkey) and the post-trim GRANT column
    // list (chore/BACKLOG-3503-trim-fees @ 107c29deb) — a rename of either
    // silently breaks this at runtime against real Postgres with no local
    // error, which is exactly why it is pinned here.
    expect(select?.args[0]).toBe(
      'id, seq, organization_id, agent_user_id, agent_pct, brokerage_pct, effective_from, note, set_by, set_at, setByUser:users!agent_split_agreements_set_by_fkey(display_name, first_name, last_name, email)'
    );
  });

  it('orders effective_from DESC, seq DESC — never set_at (the migration\'s ordering contract)', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await getSplitHistory(client, 'org-1', 'agent-1');
    const orders = calls.filter((c) => c.method === 'order');
    expect(orders).toEqual([
      { method: 'order', args: ['effective_from', { ascending: false }] },
      { method: 'order', args: ['seq', { ascending: false }] },
    ]);
  });

  it('filters to the given organization and agent', async () => {
    const { client, calls } = makeClient({ data: [], error: null });
    await getSplitHistory(client, 'org-1', 'agent-1');
    const eqs = calls.filter((c) => c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual([
      ['organization_id', 'org-1'],
      ['agent_user_id', 'agent-1'],
    ]);
  });

  it('a Supabase error resolves to [] rather than throwing — same shape as a genuinely empty history', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    await expect(getSplitHistory(client, 'org-1', 'agent-1')).resolves.toEqual([]);
  });

  it('normalizes the joined setter from an array (PostgREST embed shape) to a single object', async () => {
    const { client } = makeClient({
      data: [
        {
          ...row({}),
          setByUser: [
            {
              display_name: 'Alex Rivera',
              first_name: null,
              last_name: null,
              email: 'alex.rivera@example.test',
            },
          ],
        },
      ],
      error: null,
    });
    const history = await getSplitHistory(client, 'org-1', 'agent-1');
    expect(history[0].setByUser).toEqual({
      display_name: 'Alex Rivera',
      first_name: null,
      last_name: null,
      email: 'alex.rivera@example.test',
    });
  });
});

describe('getCurrentSplitsForOrg', () => {
  it('reduces one query result to one current row per agent, applying deriveCurrentSplit per group', async () => {
    const { client } = makeClient({
      data: [
        // agent-1: future row first (excluded), then the one in force
        row({ id: 'a1-future', agent_user_id: 'agent-1', effective_from: '2099-01-01', agent_pct: 99 }),
        row({ id: 'a1-current', agent_user_id: 'agent-1', effective_from: '2025-01-01', agent_pct: 70 }),
        // agent-2: single row
        row({ id: 'a2-only', agent_user_id: 'agent-2', effective_from: '2024-01-01', agent_pct: 60 }),
      ],
      error: null,
    });

    const result = await getCurrentSplitsForOrg(client, 'org-1');
    expect(result.get('agent-1')?.id).toBe('a1-current');
    expect(result.get('agent-2')?.id).toBe('a2-only');
    expect(result.size).toBe(2);
  });

  it('an agent with only future-dated rows is absent from the map, not present with a wrong value', async () => {
    const { client } = makeClient({
      data: [row({ id: 'future-only', agent_user_id: 'agent-1', effective_from: '2099-01-01' })],
      error: null,
    });
    const result = await getCurrentSplitsForOrg(client, 'org-1');
    expect(result.has('agent-1')).toBe(false);
  });

  it('a Supabase error resolves to an empty Map rather than throwing', async () => {
    const { client } = makeClient({ data: null, error: { message: 'boom' } });
    await expect(getCurrentSplitsForOrg(client, 'org-1')).resolves.toEqual(new Map());
  });
});

// ============================================================================
// Impersonation — the fact both callers (getAccountView, the Users list page)
// depend on and must never query against
// ============================================================================

describe('the scoped impersonation client refuses this table (measured, not assumed)', () => {
  it('createScopedClient throws on agent_split_agreements — it is not in scoped-client.ts\'s ALLOWED_TABLES', async () => {
    // A missing-table access on the REAL scoped client, not a mock of it — this
    // is what getAccountView() and the Users list page's impersonation branch
    // are written to never trigger. If this ever stops throwing (the table was
    // added to ALLOWED_TABLES), the `!impersonation` / `showSplitColumn={false}`
    // guards in getAccountView.ts and users/page.tsx should be revisited, not
    // just this test.
    const stubServiceClient = { from: jest.fn(() => ({})) } as never;
    const scoped = createScopedClient(stubServiceClient, 'target-user-1', 'org-1');
    const blocked = scoped.from('agent_split_agreements') as unknown as { select: () => unknown };
    expect(() => blocked.select()).toThrow(/not allowed during impersonation/);
  });
});
