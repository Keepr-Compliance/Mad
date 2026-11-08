/**
 * BACKLOG-4054 — the seeder's identity knob (KEEPR_QA_SEED_USER_ID + KEEPR_QA_SEED_EMAIL).
 *
 *   S1 neither set: the fixture account, unchanged.
 *   S2 both set: the user row AND every user_id the fixture writes carry the knob values.
 *   S3 exactly one set: refused (both directions), from resolveSeedIdentity and from defaultFixture.
 *   S4 a non-UUID id or a non-email is refused; refusal messages never echo the values.
 *   S5 main() refuses before any app or DB work (the check sits ahead of app.whenReady).
 *
 * Synthetic identity only (all-zero-style UUID, example.invalid). Pure Node, no Electron.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// pii-allow-uuid: invented test id, not from any live row
const KNOB_ID = 'c0000000-0000-4000-8000-000000004054';
const KNOB_EMAIL = 'qa.identity@example.invalid';
const KEYS = ['KEEPR_QA_SEED_USER_ID', 'KEEPR_QA_SEED_EMAIL', 'KEEPR_QA_EXPORT_COMPLETENESS'] as const;

type Seed = {
  defaultFixture: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  resolveSeedIdentity: (env?: NodeJS.ProcessEnv) => { userId: string; email: string };
  DEFAULT_SEED_USER_ID: string;
  DEFAULT_SEED_EMAIL: string;
};

function withEnv<T>(env: Partial<Record<(typeof KEYS)[number], string>>, fn: (seed: Seed) => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    let out!: T;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      out = fn(require('../seed-fixture.js') as Seed);
    });
    return out;
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** Every `user_id` / `userId` value anywhere in the fixture. */
function userIds(o: unknown, out: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => userIds(x, out));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'user_id' || k === 'userId') out.push(String(v));
      userIds(v, out);
    }
  }
  return out;
}

describe('seeder identity knob (BACKLOG-4054)', () => {
  it('S1 neither knob: the fixture account, unchanged', () => {
    withEnv({}, (seed) => {
      const fx = seed.defaultFixture();
      // pii-allow-uuid: the seeder's invented default fixture id
      expect(fx.user.id).toBe('a0000000-0000-4000-8000-00000000e2e0');
      expect(fx.user.email).toBe('qa.seed@keepr.test');
      expect(seed.DEFAULT_SEED_USER_ID).toBe(fx.user.id);
      expect(seed.DEFAULT_SEED_EMAIL).toBe(fx.user.email);
      expect([...new Set(userIds(fx))]).toEqual([fx.user.id]);
    });
  });

  it('S2 both knobs: the user row and every user_id carry the knob values', () => {
    withEnv(
      { KEEPR_QA_SEED_USER_ID: KNOB_ID, KEEPR_QA_SEED_EMAIL: KNOB_EMAIL, KEEPR_QA_EXPORT_COMPLETENESS: '1' },
      (seed) => {
        const fx = seed.defaultFixture();
        expect(fx.user.id).toBe(KNOB_ID);
        expect(fx.user.email).toBe(KNOB_EMAIL);
        const ids = userIds(fx);
        expect(ids.length).toBeGreaterThan(10);
        expect([...new Set(ids)]).toEqual([KNOB_ID]);
      },
    );
  });

  it.each([
    ['id only', { KEEPR_QA_SEED_USER_ID: KNOB_ID }],
    ['email only', { KEEPR_QA_SEED_EMAIL: KNOB_EMAIL }],
  ])('S3 %s: refused by resolveSeedIdentity and by defaultFixture', (_label, env) => {
    withEnv(env, (seed) => {
      expect(() => seed.resolveSeedIdentity(process.env)).toThrow(/must be set together, or neither/);
      expect(() => seed.defaultFixture()).toThrow(/must be set together, or neither/);
    });
  });

  it.each([
    ['non-UUID id', { KEEPR_QA_SEED_USER_ID: 'qa-seed-user', KEEPR_QA_SEED_EMAIL: KNOB_EMAIL }, /must be a UUID/],
    ['non-email', { KEEPR_QA_SEED_USER_ID: KNOB_ID, KEEPR_QA_SEED_EMAIL: 'not-an-email' }, /must be an email address/],
  ])('S4 %s: refused, and the message never echoes the values', (_label, env, re) => {
    withEnv({}, (seed) => {
      let msg = '';
      try {
        seed.resolveSeedIdentity(env);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(re);
      for (const v of Object.values(env)) expect(msg).not.toContain(v);
    });
  });

  it('S5 main() checks the identity before app.whenReady (refusal exits 2 via fail)', () => {
    const src = readFileSync(join(__dirname, '..', 'seed-fixture.js'), 'utf8');
    const main = src.slice(src.indexOf('function main()'));
    const check = main.indexOf('resolveSeedIdentity(process.env)');
    const ready = main.indexOf('app.whenReady()');
    expect(check).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(check);
    expect(main.slice(check, ready)).toMatch(/catch \(err\) \{\s*fail\(err\);\s*return;/);
  });
});
