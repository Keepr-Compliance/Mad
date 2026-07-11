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

describe('seed-fixture default fixture shape (BACKLOG-1940)', () => {
  const fx = seed.defaultFixture() as {
    user: { id: string; email: string; oauth_provider: string };
    session: { user_id: string; session_token: string; expires_at: string };
    contacts: Array<{ id: string; user_id: string; email: string }>;
    transaction: { id: string; user_id: string; property_address: string };
    emails: Array<{ id: string; user_id: string }>;
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

  it('every communication links a real email to the real transaction (referential integrity)', () => {
    const emailIds = new Set(fx.emails.map((e) => e.id));
    expect(fx.communications.length).toBeGreaterThanOrEqual(1);
    for (const cm of fx.communications) {
      expect(cm.transaction_id).toBe(fx.transaction.id);
      expect(emailIds.has(cm.email_id)).toBe(true);
      expect(cm.user_id).toBe(fx.user.id);
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
