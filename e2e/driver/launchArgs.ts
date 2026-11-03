import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDriverOptions } from './types';

/**
 * App launch argv, kept free of Playwright imports so the Node jest run can unit-test it.
 */

export function isDefaultProfile(opts: AppDriverOptions): boolean {
  return opts.reuseProfile !== false && !opts.userDataDir;
}

/**
 * Build the app args, adding --user-data-dir only when an isolated profile is requested.
 *
 * BACKLOG-4093: an isolated profile also gets --use-mock-keychain, so the app under test reads the
 * seeder's mock-keychain DB key and never asks the macOS login keychain for the installed app's
 * "keepr Safe Storage" item. The DEFAULT-profile branch must NOT get it: a mock keychain cannot
 * decrypt the real profile's key.
 */
export function buildArgs(opts: AppDriverOptions): { args: string[]; userDataDir: string } {
  const extra = opts.extraArgs ?? [];
  if (isDefaultProfile(opts)) {
    // Reuse the persisted profile: do NOT pass --user-data-dir; the app uses its default.
    return { args: [...extra], userDataDir: '<default persisted profile>' };
  }
  const userDataDir = opts.userDataDir ?? mkdtempSync(join(tmpdir(), 'keepr-e2e-'));
  // Electron maps the Chromium --user-data-dir switch onto app userData (`=` form only).
  return { args: [`--user-data-dir=${userDataDir}`, '--use-mock-keychain', ...extra], userDataDir };
}
