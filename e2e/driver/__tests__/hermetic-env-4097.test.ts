/**
 * @jest-environment node
 *
 * BACKLOG-4097 — the hermetic export spec launches with Supabase and Sentry pinned to '' so a run
 * from a tree whose .env.development names a live backend never reaches it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

const mockLaunch = jest.fn();
jest.mock('@playwright/test', () => ({
  _electron: { launch: (...a: unknown[]) => mockLaunch(...a) },
  chromium: {},
}));
jest.mock('../paths', () => ({
  ...jest.requireActual('../paths'),
  resolveBuiltMainEntry: jest.fn(() => '/repo/dist-electron/main.js'),
}));
jest.mock('../launchArgs', () => ({
  ...jest.requireActual('../launchArgs'),
  buildUnpackagedLaunch: jest.fn(() => ({ executablePath: '/wrapper', args: ['.'], userDataDir: '/scratch/p' })),
  launchedIsolationFailure: jest.fn(() => null),
}));

import { HERMETIC_APP_ENV } from '../launchArgs';
import { launchUnpackaged } from '../launch';

const REPO = join(__dirname, '..', '..', '..');
const KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SENTRY_DSN'] as const;

describe('BACKLOG-4097: hermetic env pin', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      process.env[k] = `https://live.invalid/${k}`;
    }
    mockLaunch.mockResolvedValue({
      evaluate: jest.fn(async () => ({})),
      firstWindow: jest.fn(async () => ({})),
      close: jest.fn(async () => undefined),
    });
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('pins the backend and crash-report variables to empty', () => {
    for (const k of KEYS) expect(HERMETIC_APP_ENV[k]).toBe('');
  });

  it('launchUnpackaged gives the caller env the last word over the shell env', async () => {
    await launchUnpackaged({ repoRoot: REPO, reuseProfile: false, userDataDir: '/scratch/p', env: { ...HERMETIC_APP_ENV } });
    const env = mockLaunch.mock.calls[0][0].env as Record<string, string>;
    for (const k of KEYS) expect(env[k]).toBe('');
    expect(env.KEEPR_E2E).toBe('1');
  });

  it('dotenv (as installed) does not override a variable already set to empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keepr-4097-env-'));
    try {
      const file = join(dir, '.env.development');
      writeFileSync(file, 'SUPABASE_URL=https://live.invalid\n');
      process.env.SUPABASE_URL = '';
      dotenv.config({ path: file, quiet: true } as dotenv.DotenvConfigOptions);
      expect(process.env.SUPABASE_URL).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the app loads its dev env files without override', () => {
    const src = readFileSync(join(REPO, 'electron', 'bootstrap', 'installSentry.ts'), 'utf8');
    const calls = src.match(/dotenv\.config\(.*$/gm) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c).not.toMatch(/override/);
  });

  it('the hermetic export spec launches with the pin', () => {
    const spec = readFileSync(join(REPO, 'e2e', 'tests', 'export-completeness.spec.ts'), 'utf8');
    const body = spec.slice(spec.indexOf('async function launchLoggedIn'), spec.indexOf('test.describe('));
    expect(body).toMatch(/env:\s*\{\s*\.\.\.HERMETIC_APP_ENV\s*\}/);
  });
});
