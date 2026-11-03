/**
 * BACKLOG-4093 (C4) — app launch argv: an isolated profile gets the `=` form of --user-data-dir AND
 * --use-mock-keychain (so the app reads the seeder's mock-keychain DB key and never prompts for the
 * real "keepr Safe Storage" item); the default persisted profile gets NEITHER (a mock keychain cannot
 * decrypt the real profile's key). Pure Node: launchArgs.ts has no Playwright import.
 */
import { buildArgs } from '../launchArgs';

describe('buildArgs', () => {
  it('isolated profile: = form + --use-mock-keychain', () => {
    const { args, userDataDir } = buildArgs({ userDataDir: '/scratch/p' } as never);
    expect(userDataDir).toBe('/scratch/p');
    expect(args).toContain('--user-data-dir=/scratch/p');
    expect(args).toContain('--use-mock-keychain');
    expect(args).not.toContain('--user-data-dir');
  });

  it('isolated profile via reuseProfile:false also gets the mock keychain', () => {
    const { args } = buildArgs({ reuseProfile: false } as never);
    expect(args).toContain('--use-mock-keychain');
  });

  it('default persisted profile: no --user-data-dir and NO --use-mock-keychain', () => {
    const { args } = buildArgs({ extraArgs: ['--foo'] } as never);
    expect(args).toEqual(['--foo']);
    expect(args).not.toContain('--use-mock-keychain');
  });
});
