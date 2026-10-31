/**
 * Isolated-profile seeding for the reliable QA driver (BACKLOG-1940 pivot).
 *
 * Prepares an ISOLATED Electron userData profile so the driver lands logged-in with real,
 * clickable content — WITHOUT real OAuth and WITHOUT touching the real keepr profile:
 *
 *   1. spawn scripts/qa/harness/seed-fixture.js (Electron-main) which — on the isolated profile —
 *      calls the app's OWN databaseService.initialize() to create the encrypted `mad.db` +
 *      `db-key-store.json` + full schema, then raw-INSERTs the known fixture (user + session +
 *      contacts + a transaction + emails + links) via the H3 cipher-open path;
 *   2. write `session.json` whose sessionToken matches the seeded DB session, and which has NO
 *      supabaseTokens — so main's getCurrentUser authenticates purely from the fixture (all the
 *      real-Supabase setSession/getUser blocks are gated on supabaseTokens being present).
 *
 * The result is a profile that, on the NEXT launch, authenticates offline with a seeded
 * transaction the driver can open. Everything here is confined to the isolated profile — the
 * seeder REFUSES to touch the real keepr profile.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveElectronBinary } from '../paths';

/** The identity the seeder wrote — used to wire session.json and assert the driver's landing. */
export interface SeededIdentity {
  userId: string;
  email: string;
  sessionToken: string;
  sessionExpiresAt: string;
  provider: string;
  transactionId: string;
  propertyAddress: string;
  contacts: number;
  emails: number;
}

const SEED_SENTINEL = '__QA_SEED_JSON__ ';

/** How the seeder process is launched — exported so the argv contract is unit-testable. */
export interface SeedSpawn {
  command: string;
  args: string[];
}

/**
 * BACKLOG-4093: the seeder runs through the in-repo sandbox wrapper (macOS), with the mock keychain
 * and the Chromium `=` form of --user-data-dir ONLY. Never add the bare `--user-data-dir <dir>`
 * form: Chromium ignores it, and passing both forms sends userData to `<appData>/Electron`.
 * The seeder's own guard (seederGuard.js) refuses every launch that breaks this contract.
 */
export function buildSeedSpawn(
  repoRoot: string,
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
): SeedSpawn {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'seed-fixture.js');
  const args = ['--use-mock-keychain', `--user-data-dir=${profileDir}`, script];
  if (platform !== 'darwin') {
    return { command: resolveElectronBinary(repoRoot), args };
  }
  const wrapper = join(repoRoot, 'scripts', 'qa', 'harness', 'electron-sandboxed.sh');
  if (!existsSync(wrapper)) {
    throw new Error(`[keepr-e2e] seed sandbox wrapper not found at ${wrapper}. Refusing to run the seeder unsandboxed.`);
  }
  return { command: wrapper, args };
}

/** Spawn the Electron-main seed script (self-provisions the DB) and parse the emitted identity. */
function runSeedScript(repoRoot: string, profileDir: string): SeededIdentity {
  const { command, args } = buildSeedSpawn(repoRoot, profileDir);
  const res = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    // A seed takes well under a second; a long wait means a blocked prompt or a missed entry check.
    timeout: 30_000,
  });
  if (res.error || res.status === null) {
    const why = res.error ? res.error.message : `killed by ${res.signal ?? 'signal'}`;
    throw new Error(
      `[keepr-e2e] seed-fixture did not finish (${why}). A hang here has meant a keychain prompt or an entry ` +
        `check that never matched — see BACKLOG-4093. Output:\n${res.stdout ?? ''}${res.stderr ?? ''}`,
    );
  }
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith(SEED_SENTINEL));
  if (!line) {
    throw new Error(`[keepr-e2e] seed-fixture produced no result line. Output:\n${out}`);
  }
  const parsed = JSON.parse(line.slice(SEED_SENTINEL.length));
  if (!parsed.seeded) {
    throw new Error(`[keepr-e2e] seed-fixture failed: ${parsed.error ?? 'unknown error'}`);
  }
  return parsed as SeededIdentity;
}

/**
 * Write session.json into the isolated profile. Plaintext SessionData (the app auto-migrates it to
 * an encrypted wrapper on first read). NO supabaseTokens → getCurrentUser authenticates from the
 * seeded DB session alone, with no real Supabase call and no login wall.
 */
function writeSessionJson(profileDir: string, id: SeededIdentity): void {
  const now = Date.now();
  const session = {
    user: {
      id: id.userId,
      email: id.email,
      display_name: 'QA Seed',
    },
    sessionToken: id.sessionToken,
    provider: id.provider,
    expiresAt: new Date(id.sessionExpiresAt).getTime(),
    createdAt: now,
    savedAt: now,
    // Deliberately NO supabaseTokens (skips all real-Supabase validation branches).
    // A recent lastServerValidatedAt keeps the pre-auth offline-grace path valid too.
    lastServerValidatedAt: now,
  };
  writeFileSync(join(profileDir, 'session.json'), JSON.stringify(session, null, 2), 'utf8');
}

/**
 * Full seed: provision DB → seed fixture → write session.json. Idempotent-ish (re-seeding the same
 * profile OR-REPLACEs rows). Returns the seeded identity for the driver to assert against.
 */
export async function seedIsolatedProfile(repoRoot: string, profileDir: string): Promise<SeededIdentity> {
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
  const identity = runSeedScript(repoRoot, profileDir);
  writeSessionJson(profileDir, identity);
  return identity;
}
