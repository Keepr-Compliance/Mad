/**
 * BACKLOG-4054 — the seeder's identity knobs reach it ONLY through seedIsolatedProfile's `identity`
 * option, in the seed spawn's env. A copy exported in the shell is dropped.
 *
 * Pure Node: spawnSync is mocked, so no seeder or Electron runs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSpawnSync = jest.fn();
jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawnSync: (...a: unknown[]) => mockSpawnSync(...a),
}));

import { buildSeedEnv, seedIsolatedProfile, SEED_IDENTITY_ENV_KEYS } from '../seed/seedProfile';

const repoRoot = join(__dirname, '..', '..', '..');
// pii-allow-uuid: invented test ids (all-zero style), not from any live row
const ID = { userId: 'c0000000-0000-4000-8000-000000004054', email: 'qa.identity@example.invalid' };
// pii-allow-uuid: invented test id, not from any live row
const LEAKED = { KEEPR_QA_SEED_USER_ID: 'd0000000-0000-4000-8000-000000004054', KEEPR_QA_SEED_EMAIL: 'leaked@example.invalid' };

describe('buildSeedEnv (BACKLOG-4054)', () => {
  it('E1 no identity: inherited knobs are dropped, the rest is kept', () => {
    const env = buildSeedEnv({ ...LEAKED, PATH: '/bin' });
    for (const k of SEED_IDENTITY_ENV_KEYS) expect(env).not.toHaveProperty(k);
    expect(env.PATH).toBe('/bin');
    expect(env.ELECTRON_ENABLE_LOGGING).toBe('0');
  });

  it('E2 identity given: it wins over an inherited copy', () => {
    const env = buildSeedEnv({ ...LEAKED }, ID);
    expect(env.KEEPR_QA_SEED_USER_ID).toBe(ID.userId);
    expect(env.KEEPR_QA_SEED_EMAIL).toBe(ID.email);
  });
});

describe('seedIsolatedProfile passes the identity only in the spawn env (BACKLOG-4054)', () => {
  const saved = { ...process.env };
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'keepr-4054-seedenv-'));
    Object.assign(process.env, LEAKED);
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: `__QA_SEED_JSON__ ${JSON.stringify({ seeded: true, userId: ID.userId, email: ID.email, sessionToken: 't', sessionExpiresAt: '2099-01-01T00:00:00.000Z', provider: 'google', transactionId: 'x', propertyAddress: 'y', contacts: 0, emails: 0 })}\n`,
      stderr: '',
    });
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it('E3 with identity: the spawn env carries it', async () => {
    await seedIsolatedProfile(repoRoot, dir, { identity: ID });
    const env = mockSpawnSync.mock.calls[0][2].env as NodeJS.ProcessEnv;
    expect(env.KEEPR_QA_SEED_USER_ID).toBe(ID.userId);
    expect(env.KEEPR_QA_SEED_EMAIL).toBe(ID.email);
  });

  it('E4 without identity: a shell-exported knob never reaches the seeder', async () => {
    await seedIsolatedProfile(repoRoot, dir);
    const env = mockSpawnSync.mock.calls[0][2].env as NodeJS.ProcessEnv;
    for (const k of SEED_IDENTITY_ENV_KEYS) expect(env).not.toHaveProperty(k);
  });
});
