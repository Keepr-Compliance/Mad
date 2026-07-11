/**
 * Env-gated manual-attach seed variant proofs (BACKLOG-1979).
 *
 * Guarantees the manual-attach cell's seed change is:
 *   1. COUNT-NEUTRAL on the DEFAULT path — defaultFixture() with NO env var is byte-identical to
 *      before (the same 9 emails — 4 match + 2 no-match + 2 decoy + 1 own — none of them the
 *      manual-attach target; the KEEPR_QA_MANUAL_ATTACH='1' variant appends the 1 target → 10), so the
 *      BACKLOG-1950 fidelity guard (fixture-filter-counts.fidelity.test.ts) stays 7/7 and OFF=6 / ON=4 hold.
 *   2. ADDITIVE + out-of-window under KEEPR_QA_MANUAL_ATTACH='1' — it appends EXACTLY ONE extra email
 *      that is a legitimate participant+address match but sent BEFORE the transaction window, so the
 *      runtime on-open auto-link never links it (it stays UNLINKED for the manual-attach flow to link).
 *
 * Pure Node (no Electron/DB) → runs under npm run qa:test.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../seed-fixture.js') as {
  defaultFixture: () => {
    transaction: { started_at: string };
    emails: Array<{ id: string; class: string; from: string; sent_at: string; subject: string }>;
    contacts: Array<{ email: string }>;
  };
  FIXTURE_WINDOW_START: string;
  MANUAL_ATTACH_EMAIL_ID: string;
  MANUAL_ATTACH_SEARCH_TOKEN: string;
};

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('manual-attach env-gated seed (BACKLOG-1979)', () => {
  it('DEFAULT path is count-neutral: 9 emails, none is the manual-attach target', () => {
    const fx = withEnv('KEEPR_QA_MANUAL_ATTACH', undefined, () => seed.defaultFixture());
    // The BACKLOG-1950 corpus is 9 (4 match + 2 no-match + 2 decoy + 1 own) — unchanged.
    expect(fx.emails.length).toBe(9);
    expect(fx.emails.some((e) => e.id === seed.MANUAL_ATTACH_EMAIL_ID)).toBe(false);
    // The BACKLOG-1950 corpus classes are untouched (no 'manual-attach' class on the default path).
    expect(fx.emails.some((e) => e.class === 'manual-attach')).toBe(false);
  });

  it("KEEPR_QA_MANUAL_ATTACH='1' appends EXACTLY one extra email (the manual-attach target)", () => {
    const fx = withEnv('KEEPR_QA_MANUAL_ATTACH', '1', () => seed.defaultFixture());
    expect(fx.emails.length).toBe(10); // 9 default + 1 appended target
    const target = fx.emails.find((e) => e.id === seed.MANUAL_ATTACH_EMAIL_ID);
    expect(target).toBeDefined();
    expect(target!.class).toBe('manual-attach');
    expect(target!.subject.toLowerCase()).toContain(seed.MANUAL_ATTACH_SEARCH_TOKEN);
  });

  it('the target is a legitimate participant match (a transaction contact is the sender)', () => {
    const fx = withEnv('KEEPR_QA_MANUAL_ATTACH', '1', () => seed.defaultFixture());
    const contactAddrs = new Set(fx.contacts.map((c) => c.email.toLowerCase().trim()));
    const target = fx.emails.find((e) => e.id === seed.MANUAL_ATTACH_EMAIL_ID)!;
    expect(contactAddrs.has(target.from.toLowerCase().trim())).toBe(true);
  });

  it('the target is OUT OF WINDOW: sent strictly before the transaction window start', () => {
    const fx = withEnv('KEEPR_QA_MANUAL_ATTACH', '1', () => seed.defaultFixture());
    const target = fx.emails.find((e) => e.id === seed.MANUAL_ATTACH_EMAIL_ID)!;
    expect(new Date(target.sent_at).getTime()).toBeLessThan(new Date(seed.FIXTURE_WINDOW_START).getTime());
    // Sanity: the window start equals the transaction's started_at (closed_at=null → end=now).
    expect(fx.transaction.started_at).toBe(seed.FIXTURE_WINDOW_START);
  });

  it('the unique search token is absent from every DEFAULT-path email (isolation guarantee)', () => {
    const fx = withEnv('KEEPR_QA_MANUAL_ATTACH', undefined, () => seed.defaultFixture());
    const token = seed.MANUAL_ATTACH_SEARCH_TOKEN.toLowerCase();
    for (const e of fx.emails) {
      expect(e.subject.toLowerCase().includes(token)).toBe(false);
    }
  });
});
