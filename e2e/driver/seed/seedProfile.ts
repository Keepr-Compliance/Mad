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

/** Spawn the Electron-main seed script (self-provisions the DB) and parse the emitted identity. */
function runSeedScript(repoRoot: string, profileDir: string): SeededIdentity {
  const electronBin = resolveElectronBinary(repoRoot);
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'seed-fixture.js');
  const res = spawnSync(electronBin, [script, '--user-data-dir', profileDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 120_000,
  });
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
