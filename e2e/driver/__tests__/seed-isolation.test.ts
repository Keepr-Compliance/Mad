/**
 * BACKLOG-4093 — the fixture seeder runs only in the requested isolated profile, with the mock
 * keychain, launched through the sandbox wrapper.
 *
 *   - buildSeedSpawn: wrapper on macOS, `--user-data-dir=` form only, `--use-mock-keychain`;
 *   - seederGuard.isolationFailure: mock switch required, space form refused, userData must equal
 *     the requested dir (realpath both sides), never inside <appData>/{keepr,Keepr,keepr-dev,Electron};
 *   - seederGuard.isEntryScript: the script is found behind the wrapper's leading Electron switches.
 *
 * Pure Node → no Electron, no app launch, no DB.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSeedSpawn } from '../seed/seedProfile';

interface GuardOpts {
  userDataDir?: string;
  userDataDirSpaceForm?: string;
  fixture?: string;
  out?: string;
  help?: boolean;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../../scripts/qa/harness/seederGuard.js') as {
  GUARD_EXIT_CODE: number;
  isEntryScript: (argv: string[], filename: string) => boolean;
  parseArgs: (argv: string[]) => GuardOpts;
  isolationFailure: (p: {
    hasMockKeychain: boolean;
    opts: GuardOpts;
    actualUserData: string;
    appData: string;
    realpath?: (p: string) => string;
  }) => string | null;
};

const REPO = '/repo';
const PROFILE = '/scratch/qa-profile';
const APP_DATA = '/Users/qa/Library/Application Support';
const identity = (p: string): string => p;

describe('buildSeedSpawn (BACKLOG-4093)', () => {
  // The wrapper exists in this checkout, so resolve against the real repo root.
  const repoRoot = join(__dirname, '..', '..', '..');

  it('macOS: launches the in-repo sandbox wrapper, not the bare electron binary', () => {
    const s = buildSeedSpawn(repoRoot, PROFILE, 'darwin');
    expect(s.command).toBe(join(repoRoot, 'scripts', 'qa', 'harness', 'electron-sandboxed.sh'));
  });

  it('passes ONLY the Chromium `=` form of --user-data-dir (never the space form)', () => {
    const { args } = buildSeedSpawn(repoRoot, PROFILE, 'darwin');
    expect(args).toContain(`--user-data-dir=${PROFILE}`);
    expect(args).not.toContain('--user-data-dir');
    expect(args.filter((a) => a.startsWith('--user-data-dir'))).toHaveLength(1);
  });

  it('passes --use-mock-keychain', () => {
    expect(buildSeedSpawn(repoRoot, PROFILE, 'darwin').args).toContain('--use-mock-keychain');
  });

  it('passes the seeder script', () => {
    expect(buildSeedSpawn(repoRoot, PROFILE, 'darwin').args).toContain(
      join(repoRoot, 'scripts', 'qa', 'harness', 'seed-fixture.js'),
    );
  });

  it('refuses to run unsandboxed when the wrapper is missing', () => {
    expect(() => buildSeedSpawn(REPO, PROFILE, 'darwin')).toThrow(/wrapper not found/);
  });

  it('the argv it builds passes the seeder guard (contract between spawner and guard)', () => {
    const { args } = buildSeedSpawn(repoRoot, PROFILE, 'darwin');
    const opts = guard.parseArgs(['/x/Electron', '--no-sandbox', ...args]);
    expect(
      guard.isolationFailure({ hasMockKeychain: args.includes('--use-mock-keychain'), opts, actualUserData: PROFILE, appData: APP_DATA, realpath: identity }),
    ).toBeNull();
  });
});

describe('seederGuard.parseArgs', () => {
  it('reads the `=` form', () => {
    expect(guard.parseArgs(['--user-data-dir=/tmp/p']).userDataDir).toBe('/tmp/p');
  });

  it('records the bare space form separately (refused by the guard)', () => {
    const o = guard.parseArgs(['--user-data-dir', '/tmp/p']);
    expect(o.userDataDir).toBeUndefined();
    expect(o.userDataDirSpaceForm).toBe('/tmp/p');
  });

  it('reads switches before AND after the script', () => {
    const o = guard.parseArgs(['--no-sandbox', '--user-data-dir=/tmp/p', '/s/seed-fixture.js', '--out', '/tmp/o.json']);
    expect(o.userDataDir).toBe('/tmp/p');
    expect(o.out).toBe('/tmp/o.json');
  });
});

describe('seederGuard.isolationFailure', () => {
  const ok = { hasMockKeychain: true, opts: { userDataDir: PROFILE }, actualUserData: PROFILE, appData: APP_DATA, realpath: identity };

  it('allows the requested isolated profile', () => {
    expect(guard.isolationFailure(ok)).toBeNull();
  });

  it('C2c: refuses without --use-mock-keychain', () => {
    expect(guard.isolationFailure({ ...ok, hasMockKeychain: false })).toMatch(/use-mock-keychain/);
  });

  it('refuses the bare space form', () => {
    expect(guard.isolationFailure({ ...ok, opts: { userDataDirSpaceForm: PROFILE } })).toMatch(/space form/);
  });

  it('refuses both forms together (the L7 shape)', () => {
    expect(guard.isolationFailure({ ...ok, opts: { userDataDir: PROFILE, userDataDirSpaceForm: PROFILE } })).not.toBeNull();
  });

  it('refuses a missing --user-data-dir', () => {
    expect(guard.isolationFailure({ ...ok, opts: {} })).toMatch(/requires --user-data-dir=/);
  });

  it('C2a: refuses when Electron uses a different directory than requested', () => {
    expect(guard.isolationFailure({ ...ok, actualUserData: '/scratch/other-profile' })).toMatch(/mismatch/);
  });

  it.each(['keepr', 'Keepr', 'keepr-dev', 'Electron'])('C2b: refuses <appData>/%s even when requested', (name) => {
    const real = join(APP_DATA, name);
    expect(
      guard.isolationFailure({ ...ok, opts: { userDataDir: real }, actualUserData: real }),
    ).toMatch(/REFUSING/);
  });

  it('C2b: refuses a directory under a real profile', () => {
    const sub = join(APP_DATA, 'keepr', 'nested');
    expect(guard.isolationFailure({ ...ok, opts: { userDataDir: sub }, actualUserData: sub })).toMatch(/REFUSING/);
  });

  it('refuses a directory that contains the real application data directory', () => {
    const home = '/Users/qa';
    expect(guard.isolationFailure({ ...ok, opts: { userDataDir: home }, actualUserData: home })).toMatch(/contains/);
  });

  describe('C6: symlinked profile path (e.g. /tmp -> /private/tmp, /var/folders -> /private/var/folders)', () => {
    let base: string;
    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), 'seed-guard-'));
    });
    afterEach(() => rmSync(base, { recursive: true, force: true }));

    it('accepts a requested symlink whose target is what Electron reports', () => {
      const realDir = join(base, 'real');
      mkdirSync(realDir);
      const link = join(base, 'link');
      symlinkSync(realDir, link, 'junction');
      expect(
        guard.isolationFailure({ hasMockKeychain: true, opts: { userDataDir: link }, actualUserData: realpathSync(realDir), appData: APP_DATA }),
      ).toBeNull();
    });

    it('accepts a not-yet-created profile under a symlinked parent', () => {
      const link = join(base, 'link');
      symlinkSync(base, link, 'junction');
      expect(
        guard.isolationFailure({
          hasMockKeychain: true,
          opts: { userDataDir: join(link, 'not-yet') },
          actualUserData: join(realpathSync(base), 'not-yet'),
          appData: APP_DATA,
        }),
      ).toBeNull();
    });
  });
});

describe('seederGuard.isEntryScript (C3)', () => {
  const script = '/repo/scripts/qa/harness/seed-fixture.js';

  it('finds the script behind the wrapper switches (argv[1] is --no-sandbox)', () => {
    expect(guard.isEntryScript(['/x/Electron', '--no-sandbox', '--use-mock-keychain', '--user-data-dir=/p', script], script)).toBe(true);
  });

  it('finds the script at argv[1]', () => {
    expect(guard.isEntryScript(['/x/Electron', script, '--out', '/tmp/o'], script)).toBe(true);
  });

  it('is false when the script is only required (jest)', () => {
    expect(guard.isEntryScript(['/usr/bin/node', '/repo/node_modules/jest/bin/jest.js', 'e2e/driver'], script)).toBe(false);
  });
});

describe('guard exit code', () => {
  it('is 3', () => {
    expect(guard.GUARD_EXIT_CODE).toBe(3);
  });
});
