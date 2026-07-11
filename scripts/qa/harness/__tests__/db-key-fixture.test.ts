/**
 * Unit proofs for the SHARED fixed-DB-key helper (BACKLOG-1971).
 *
 * These guarantee the keychain-free isolation contract every cell now inherits: the fixed key is a
 * valid raw cipher key, an env override wins, applyFixtureDbKey() ARMS process.env so the seeder +
 * every reader (count-linked.js, db-assert.js, clear-linked.js) use it directly (no safeStorage),
 * and the shape/provisioning assertions surface a bad key as a HARNESS_ERROR up front.
 *
 * Pure Node → no app launch, no Electron, no DB. Runs under jest.qa.config.js
 * (scripts/qa/harness/**​/__tests__/**).
 */
import {
  applyFixtureDbKey,
  assertFixtureKeyProvisioned,
  DB_KEY_ENV,
  DEFAULT_FIXTURE_DB_KEY,
  FIXTURE_DB_KEY,
  FIXTURE_DB_KEY_LENGTH,
  fixtureKeyEnv,
  isValidFixtureDbKey,
  resolveFixtureDbKey,
} from '../db-key-fixture';

describe('the built-in fixed key has the seeded/validated shape', () => {
  it('DEFAULT_FIXTURE_DB_KEY is the 64-char string the seeder + readers were validated with', () => {
    expect(DEFAULT_FIXTURE_DB_KEY).toHaveLength(FIXTURE_DB_KEY_LENGTH);
    expect(isValidFixtureDbKey(DEFAULT_FIXTURE_DB_KEY)).toBe(true);
    // Guard the exact value: it must NEVER drift independently of the seeder (seed↔read equality).
    expect(DEFAULT_FIXTURE_DB_KEY).toBe('a11ce0ffee0000fixturefilterdbkey0123456789abcdef0123456789abcdef');
  });

  it('FIXTURE_DB_KEY resolves to the default when no env override is present at import', () => {
    // In the jest env KEEPR_QA_DB_KEY is unset, so the module-level constant is the default.
    expect(FIXTURE_DB_KEY).toBe(DEFAULT_FIXTURE_DB_KEY);
  });
});

describe('resolveFixtureDbKey: env override wins, else default', () => {
  it('returns the default when the env var is unset', () => {
    expect(resolveFixtureDbKey({})).toBe(DEFAULT_FIXTURE_DB_KEY);
  });

  it('returns a trimmed env override when present', () => {
    const custom = 'f'.repeat(64);
    expect(resolveFixtureDbKey({ [DB_KEY_ENV]: `  ${custom}  ` })).toBe(custom);
  });

  it('ignores an empty/whitespace-only override (falls back to default)', () => {
    expect(resolveFixtureDbKey({ [DB_KEY_ENV]: '   ' })).toBe(DEFAULT_FIXTURE_DB_KEY);
    expect(resolveFixtureDbKey({ [DB_KEY_ENV]: '' })).toBe(DEFAULT_FIXTURE_DB_KEY);
  });
});

describe('applyFixtureDbKey ARMS the env so the seeder + readers skip the keychain', () => {
  it('sets KEEPR_QA_DB_KEY on the given env and returns the key', () => {
    const env: NodeJS.ProcessEnv = {};
    const key = applyFixtureDbKey(env);
    expect(env[DB_KEY_ENV]).toBe(DEFAULT_FIXTURE_DB_KEY);
    expect(key).toBe(DEFAULT_FIXTURE_DB_KEY);
  });

  it('honours an existing override and is idempotent', () => {
    const custom = 'a'.repeat(64);
    const env: NodeJS.ProcessEnv = { [DB_KEY_ENV]: custom };
    expect(applyFixtureDbKey(env)).toBe(custom);
    expect(applyFixtureDbKey(env)).toBe(custom); // second call → same key
    expect(env[DB_KEY_ENV]).toBe(custom);
  });
});

describe('fixtureKeyEnv builds the child-process env fragment', () => {
  it('spreads KEEPR_QA_DB_KEY for a spawned reader (keeps the read keychain-free)', () => {
    expect(fixtureKeyEnv()).toEqual({ [DB_KEY_ENV]: DEFAULT_FIXTURE_DB_KEY });
    const custom = 'b'.repeat(64);
    expect(fixtureKeyEnv(custom)).toEqual({ [DB_KEY_ENV]: custom });
  });
});

describe('isValidFixtureDbKey / assertFixtureKeyProvisioned reject malformed keys', () => {
  it('rejects wrong-length/empty/nullish keys (length is the shape contract)', () => {
    expect(isValidFixtureDbKey(undefined)).toBe(false);
    expect(isValidFixtureDbKey(null)).toBe(false);
    expect(isValidFixtureDbKey('')).toBe(false);
    expect(isValidFixtureDbKey('deadbeef')).toBe(false); // too short
    expect(isValidFixtureDbKey('x'.repeat(63))).toBe(false); // one short
    expect(isValidFixtureDbKey('x'.repeat(65))).toBe(false); // one long
  });

  it('assertFixtureKeyProvisioned returns the key when armed + valid', () => {
    const env: NodeJS.ProcessEnv = {};
    applyFixtureDbKey(env);
    expect(assertFixtureKeyProvisioned(env)).toBe(DEFAULT_FIXTURE_DB_KEY);
  });

  it('assertFixtureKeyProvisioned throws (→ HARNESS_ERROR) when unset or malformed', () => {
    expect(() => assertFixtureKeyProvisioned({})).toThrow(/not provisioned\/valid/i);
    expect(() => assertFixtureKeyProvisioned({ [DB_KEY_ENV]: 'nope' })).toThrow(/not provisioned\/valid/i);
  });
});
