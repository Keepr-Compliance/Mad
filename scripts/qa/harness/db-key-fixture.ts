/**
 * SHARED fixed-DB-key provisioning for the deterministic QA harness (BACKLOG-1971).
 *
 * PROMOTED (BACKLOG-1971) out of the cell-specific filter-toggle-core.ts so it is CELL-AGNOSTIC —
 * every cell (filter-toggle, export, search/attach, edge-case, …) inherits ONE fixed KEEPR_QA_DB_KEY
 * path. filter-toggle-core.ts now re-exports FIXTURE_DB_KEY / applyFixtureDbKey from here for
 * backward compatibility; new cells should import them from THIS module directly.
 *
 * THE ISOLATION CONTRACT (why this exists — BACKLOG-1950/1971):
 *   Using ONE known key for SEEDING and for EVERY read means:
 *     (a) the seeder provisions the DB with it (no macOS safeStorage / keychain),
 *     (b) every reader (count-linked.js, db-assert.js, clear-linked.js) is passed `--key`
 *         (or reads KEEPR_QA_DB_KEY from env) and NEVER opens the keychain, and
 *     (c) there is NO second Electron process to decrypt a per-profile key — the former
 *         `emit-profile-key.js` helper (a second Electron instance that hit safeStorage per
 *         profile) has been ELIMINATED and is not on any shared path.
 *   Net effect: at most ONE interactive keychain grant EVER on a machine (only the LIVE, real-profile
 *   path via `npm run qa:db-key`), NEVER per-test, for EVERY cell.
 *
 * db-assert.js short-circuits the keychain the moment `--key`/`KEEPR_QA_DB_KEY` is present
 * (see its getEncryptionKey: `const explicit = opts.key || process.env.KEEPR_QA_DB_KEY; if (explicit) …`).
 * count-linked.js / clear-linked.js REQUIRE `--key` and open the cipher directly — they have no
 * keychain path at all. So passing this key to those readers keeps the whole shared read path
 * keychain-free by construction.
 *
 * NOT A SECRET: this key only ever encrypts a throwaway, isolated FIXTURE DB — never real user data.
 *
 * PURE-NODE: no Playwright / Electron / DOM import, so it is unit-testable without a launch and is
 * type-checked by the harness tsconfig (scripts/qa/harness/tsconfig.json).
 */

/** Env var the seeder + every reader honour to skip the keychain and use a caller-provided key. */
export const DB_KEY_ENV = 'KEEPR_QA_DB_KEY';

/**
 * The built-in FIXED, deterministic 64-char fixture DB key. Overridden by KEEPR_QA_DB_KEY when
 * already set (e.g. to reuse an already-provisioned key). NOT a secret — see the file header.
 *
 * NOTE: this is the exact string SEEDED into the fixture DB and passed to every reader's
 * `PRAGMA key = "x'<key>'"`. Its VALUE must never change independently — the seeder and the readers
 * only agree because they use the IDENTICAL string. (It is not strictly 0-9a-f hex; validity as hex
 * is irrelevant — only seed↔read equality matters. Do not "fix" it to hex.)
 */
export const DEFAULT_FIXTURE_DB_KEY = 'a11ce0ffee0000fixturefilterdbkey0123456789abcdef0123456789abcdef';

/** Expected length of the fixed key (64 chars) — the shape the seeder + readers were validated with. */
export const FIXTURE_DB_KEY_LENGTH = 64;

/**
 * The effective fixed fixture DB key for THIS process: the caller's KEEPR_QA_DB_KEY (trimmed) if
 * present, else the built-in default. Resolved once at import so a single run uses one stable key.
 */
export const FIXTURE_DB_KEY = resolveFixtureDbKey();

/** Resolve the effective fixed key: env override (trimmed, non-empty) wins, else the built-in default. */
export function resolveFixtureDbKey(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[DB_KEY_ENV]?.trim();
  return override && override.length > 0 ? override : DEFAULT_FIXTURE_DB_KEY;
}

/**
 * Ensure the fixed fixture DB key is present in `env` (default process.env) so the seeder
 * (getEncryptionKey / provisionKeyStore) and any child launched with this env use it DIRECTLY —
 * no safeStorage, no keychain. Call before seeding + before spawning any reader. Returns the key.
 *
 * Idempotent: re-applying yields the same key (env override is honoured on the first resolve).
 */
export function applyFixtureDbKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = resolveFixtureDbKey(env);
  env[DB_KEY_ENV] = key;
  return key;
}

/**
 * The env fragment to spread into a child process's `env` so it inherits the fixed key and stays
 * keychain-free. Use as: `env: { ...process.env, ...fixtureKeyEnv(), ELECTRON_RUN_AS_NODE: '1' }`.
 * Passing the key explicitly (rather than relying on ambient env) makes the keychain-free contract
 * visible at every spawn site.
 */
export function fixtureKeyEnv(key: string = FIXTURE_DB_KEY): { KEEPR_QA_DB_KEY: string } {
  return { [DB_KEY_ENV]: key } as { KEEPR_QA_DB_KEY: string };
}

/**
 * True when `key` is a usable fixed key: a non-empty string of the expected 64-char length. The
 * readers pass it to SQLCipher as `x'<key>'`; the seeder and readers agree only when they use the
 * SAME string, so cells can assert shape up front (→ HARNESS_ERROR) instead of misreading a "0 rows"
 * empty result. (Deliberately NOT a strict-hex check — the working fixed key is not 0-9a-f hex, and
 * only seed↔read equality matters; see DEFAULT_FIXTURE_DB_KEY.)
 */
export function isValidFixtureDbKey(key: string | undefined | null): key is string {
  return typeof key === 'string' && key.length === FIXTURE_DB_KEY_LENGTH;
}

/**
 * Assert the fixed key is provisioned in `env` AND well-formed, returning it. Throws (→ HARNESS_ERROR
 * upstream) otherwise. Call after applyFixtureDbKey() to prove the keychain-free path is armed before
 * seeding/reading.
 */
export function assertFixtureKeyProvisioned(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[DB_KEY_ENV]?.trim();
  if (!isValidFixtureDbKey(key)) {
    throw new Error(
      `[keepr-qa] fixture DB key is not provisioned/valid in ${DB_KEY_ENV} (got ${key === undefined ? 'undefined' : `"${key}"`}). ` +
        `Call applyFixtureDbKey() before seeding/reading so the seeder + every reader stay keychain-free.`,
    );
  }
  return key;
}
