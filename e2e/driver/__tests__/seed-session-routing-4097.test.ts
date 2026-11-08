/**
 * @jest-environment node
 *
 * BACKLOG-4097 — a seeded isolated profile lands on the app's navigation, not on
 * "Couldn't load your account settings".
 *
 * The stub seed has no Supabase session, so the app answers account setup from the session file's
 * offline cache alone (accountSetupHandlers no-session-user branch). One chain, no transcribed
 * session: the REAL seeder writes session.json into a temp profile, the REAL sessionService reads
 * it (plaintext → encrypted migration included), the REAL getAccountSetup answers, and the REAL
 * routeAccount decides the landing.
 *
 * Only the seeder's Electron child process is replaced: spawnSync returns the identity line that
 * seed-fixture.js prints, built from its own defaultFixture() with the mapping at the end of
 * seedFixture() (userId/email/sessionToken/sessionExpiresAt/provider/...).
 *
 * Pure Node → no Electron, no app launch, no DB, no network.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockUserData = { dir: '' };
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockUserData.dir) },
  ipcMain: { handle: jest.fn() },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: jest.fn((buf: Buffer) => {
      const str = buf.toString();
      if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length);
      throw new Error('Cannot decrypt');
    }),
  },
}));

const mockSpawnSync = jest.fn();
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawnSync: (...a: unknown[]) => mockSpawnSync(...a),
}));

// The stub seed's defining property: no Supabase session user.
jest.mock('../../../electron/services/supabaseService', () => ({
  __esModule: true,
  default: { getAuthUserId: () => null },
}));

jest.mock('../../../electron/services/logService', () => {
  const log = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: log, logService: log };
});

jest.mock('@sentry/electron/main', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

import { seedIsolatedProfile, SEEDED_ACCOUNT_SETUP_FINISHED_AT } from '../seed/seedProfile';
import { getAccountSetup } from '../../../electron/handlers/accountSetupHandlers';
import { routeAccount } from '../../../src/appCore/state/machine/routing/routeAccount';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const seed = require('../../../scripts/qa/harness/seed-fixture.js') as {
  defaultFixture: () => {
    user: { id: string; email: string; oauth_provider: string };
    session: { session_token: string; expires_at: string };
    transaction: { id: string; property_address: string };
    contacts: unknown[];
    emails: unknown[];
  };
};

const REPO_ROOT = join(__dirname, '..', '..', '..');
const SEED_SENTINEL = '__QA_SEED_JSON__ ';

function seederStdout(): string {
  const fx = seed.defaultFixture();
  const identity = {
    seeded: true,
    userId: fx.user.id,
    email: fx.user.email,
    sessionToken: fx.session.session_token,
    sessionExpiresAt: fx.session.expires_at,
    provider: fx.user.oauth_provider,
    transactionId: fx.transaction.id,
    propertyAddress: fx.transaction.property_address,
    contacts: fx.contacts.length,
    emails: fx.emails.length,
  };
  return `some electron noise\n${SEED_SENTINEL}${JSON.stringify(identity)}\n`;
}

describe('BACKLOG-4097: the seeded session lands on the app navigation', () => {
  let profile: string;

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), 'keepr-4097-'));
    mockUserData.dir = profile;
    mockSpawnSync.mockReturnValue({ status: 0, stdout: seederStdout(), stderr: '' });
  });

  afterEach(() => {
    rmSync(profile, { recursive: true, force: true });
  });

  it('the seeder writes accountSetupFinishedAt as an ISO-8601 string', async () => {
    await seedIsolatedProfile(REPO_ROOT, profile);
    const written = JSON.parse(readFileSync(join(profile, 'session.json'), 'utf8'));
    expect(typeof written.accountSetupFinishedAt).toBe('string');
    expect(Number.isNaN(Date.parse(written.accountSetupFinishedAt))).toBe(false);
    expect(written.accountSetupFinishedAt).toBe(SEEDED_ACCOUNT_SETUP_FINISHED_AT);
    // The stub design stays intact: still no Supabase tokens.
    expect(written).not.toHaveProperty('supabaseTokens');
  });

  it('the app reads the seeded session as setup "finished" and routes to the dashboard', async () => {
    await seedIsolatedProfile(REPO_ROOT, profile);
    const result = await getAccountSetup();
    expect(result.setup).toBe('finished');
    expect(routeAccount({ setup: result.setup }).destination).toBe('dashboard');
    // The read went through the real session file: it was migrated to the encrypted wrapper.
    const onDisk = JSON.parse(readFileSync(join(profile, 'session.json'), 'utf8'));
    expect(typeof onDisk.encrypted).toBe('string');
    // In the app, earlier startup reads migrate the file first, so routing reads the ENCRYPTED file.
    const fromEncrypted = await getAccountSetup();
    expect(fromEncrypted.setup).toBe('finished');
  });

  it('control: the same seeded session WITHOUT the field routes to "unavailable" (the BACKLOG-4097 symptom)', async () => {
    await seedIsolatedProfile(REPO_ROOT, profile);
    const path = join(profile, 'session.json');
    const s = JSON.parse(readFileSync(path, 'utf8'));
    delete s.accountSetupFinishedAt;
    require('node:fs').writeFileSync(path, JSON.stringify(s, null, 2), 'utf8');
    const result = await getAccountSetup();
    expect(result.setup).toBe('unknown');
    expect(routeAccount({ setup: result.setup }).destination).toBe('unavailable');
  });
});
