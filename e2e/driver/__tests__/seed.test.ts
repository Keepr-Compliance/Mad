/**
 * Safety + shape proofs for the QA fixture seeder (BACKLOG-1940 pivot).
 *
 * These are the guarantees that keep seeding safe and deterministic:
 *   - the seeder REFUSES to run against the real keepr profile (the critical safety invariant);
 *   - it requires an explicit --user-data-dir;
 *   - the default fixture is internally consistent (the session_token that the seeded DB row and
 *     the written session.json share, at least one transaction to click, referential integrity of
 *     the communications → emails links).
 *
 * Pure Node → no Electron, no app launch, no DB. Runs under the CI Node-jest glob
 * (e2e/driver/__tests__/**), same as the outcome-classification proofs.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../../../scripts/qa/harness/seed-fixture.js') as {
  assertIsolatedProfile: (dir: string | undefined) => void;
  defaultFixture: () => ReturnType<() => Record<string, unknown>>;
  parseArgs: (argv: string[]) => Record<string, unknown>;
  SEED_SENTINEL?: string;
};

describe('seed-fixture safety guard (BACKLOG-1940)', () => {
  it('REFUSES the real macOS keepr profile (lowercase)', () => {
    const real = join(homedir(), 'Library', 'Application Support', 'keepr');
    expect(() => seed.assertIsolatedProfile(real)).toThrow(/REFUSING to seed the REAL keepr profile/i);
  });

  it('REFUSES the real macOS Keepr profile (capitalized)', () => {
    const real = join(homedir(), 'Library', 'Application Support', 'Keepr');
    expect(() => seed.assertIsolatedProfile(real)).toThrow(/REFUSING to seed the REAL keepr profile/i);
  });

  it('requires an explicit --user-data-dir', () => {
    expect(() => seed.assertIsolatedProfile(undefined)).toThrow(/requires --user-data-dir/i);
  });

  it('ALLOWS an isolated scratch profile', () => {
    const isolated = join(homedir(), '.qa-scratch', 'keepr-pivot-profile');
    expect(() => seed.assertIsolatedProfile(isolated)).not.toThrow();
  });
});

describe('seed-fixture default fixture shape (BACKLOG-1940 / enriched BACKLOG-1947)', () => {
  const fx = seed.defaultFixture() as {
    user: { id: string; email: string; oauth_provider: string };
    session: { user_id: string; session_token: string; expires_at: string };
    contacts: Array<{ id: string; user_id: string; email: string }>;
    transactionContacts: Array<{ id: string; transaction_id: string; contact_id: string }>;
    transaction: { id: string; user_id: string; property_address: string; started_at: string; skip_address_filter: number };
    emails: Array<{ id: string; user_id: string; from: string; sent_at: string; class: string }>;
    communications: Array<{ transaction_id: string; email_id: string; user_id: string }>;
  };

  it('the session belongs to the seeded user (getCurrentUser JOIN will resolve)', () => {
    expect(fx.session.user_id).toBe(fx.user.id);
    expect(fx.session.session_token).toBeTruthy();
  });

  it('the session expires in the future (validateSession passes)', () => {
    expect(new Date(fx.session.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('provides at least one transaction to click, owned by the user', () => {
    expect(fx.transaction.property_address).toBeTruthy();
    expect(fx.transaction.user_id).toBe(fx.user.id);
  });

  it('provides content to navigate (contacts + emails)', () => {
    expect(fx.contacts.length).toBeGreaterThanOrEqual(1);
    expect(fx.emails.length).toBeGreaterThanOrEqual(1);
    for (const c of fx.contacts) expect(c.user_id).toBe(fx.user.id);
    for (const e of fx.emails) expect(e.user_id).toBe(fx.user.id);
  });

  // BACKLOG-1947: the corpus is seeded UNLINKED by default so the toggle-driven auto-link is what
  // creates the links we observe (clean-slate OFF==6 / ON==4). Pre-linking would defeat that.
  it('seeds the corpus UNLINKED by default (communications empty — toggle-driven links)', () => {
    expect(Array.isArray(fx.communications)).toBe(true);
    expect(fx.communications.length).toBe(0);
  });

  // BACKLOG-1947: contacts are ASSIGNED to the transaction (load-bearing for the UI toggle render +
  // the backend re-link loop). Every assignment references a real contact + the real transaction.
  it('assigns every contact to the transaction (transaction_contacts referential integrity)', () => {
    const contactIds = new Set(fx.contacts.map((c) => c.id));
    expect(fx.transactionContacts.length).toBe(fx.contacts.length);
    for (const txc of fx.transactionContacts) {
      expect(txc.transaction_id).toBe(fx.transaction.id);
      expect(contactIds.has(txc.contact_id)).toBe(true);
    }
  });

  // BACKLOG-1947: the transaction date window must be a FIXED past start (not now()), otherwise
  // computeTransactionDateRange yields a zero-width [now, now] window and the runtime links nothing.
  it('uses a FIXED past started_at (deterministic, non-zero date window)', () => {
    expect(fx.transaction.started_at).toBe('2026-01-01T00:00:00.000Z');
    expect(new Date(fx.transaction.started_at).getTime()).toBeLessThan(Date.now());
    // Address filter starts APPLIED (skip=0) — the driver toggles it OFF/ON.
    expect(fx.transaction.skip_address_filter).toBe(0);
  });

  // BACKLOG-1947: every email carries an explicit sent_at + a participant `from` (fed into
  // email_participants). Without these the date window + participant junction cannot resolve.
  it('every email carries a fixed sent_at and a participant address', () => {
    for (const e of fx.emails) {
      expect(e.sent_at).toBeTruthy();
      expect(Number.isNaN(new Date(e.sent_at).getTime())).toBe(false);
      expect(e.from).toBeTruthy();
    }
  });
});

describe('seed-fixture arg parsing', () => {
  it('parses --user-data-dir, --fixture, --out', () => {
    const opts = seed.parseArgs(['--user-data-dir', '/tmp/p', '--fixture', '/tmp/f.json', '--out', '/tmp/o.json']);
    expect(opts.userDataDir).toBe('/tmp/p');
    expect(opts.fixture).toBe('/tmp/f.json');
    expect(opts.out).toBe('/tmp/o.json');
  });
});
