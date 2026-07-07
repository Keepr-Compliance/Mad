import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolves the packaged Keepr app + its persisted userData profile.
 *
 * The installed /Applications build may be a dev-flavored package (its renderer can point at
 * the Vite dev server). Prefer a clean artifact from `npm run package:qa[:dir]` (dist/) for
 * deterministic runs; fall back to /Applications for a quick smoke against whatever is installed.
 * Override everything with KEEPR_APP_PATH.
 */

const APP_NAME = 'Keepr';
/** userData dir is keyed by the Electron app name (lowercase "keepr"), verified on disk. */
const USER_DATA_DIRNAME = 'keepr';

function macAppBinary(appBundle: string): string {
  return join(appBundle, 'Contents', 'MacOS', APP_NAME);
}

/** Candidate packaged-app executable paths, most-preferred first. */
export function candidateExecutables(repoRoot: string): string[] {
  const fromEnv = process.env.KEEPR_APP_PATH;
  const candidates: string[] = [];
  if (fromEnv) candidates.push(fromEnv);
  // Clean build artifacts (preferred — loads renderer from the bundled asar).
  candidates.push(macAppBinary(join(repoRoot, 'dist', 'mac-arm64', `${APP_NAME}.app`)));
  candidates.push(macAppBinary(join(repoRoot, 'dist', 'mac', `${APP_NAME}.app`)));
  // Installed build (may be dev-flavored — smoke only).
  candidates.push(macAppBinary(`/Applications/${APP_NAME}.app`));
  return candidates;
}

export function resolveExecutable(repoRoot: string, override?: string): string {
  if (override) return override;
  for (const c of candidateExecutables(repoRoot)) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `[keepr-e2e] No packaged Keepr executable found. Build one with \`npm run package:qa:dir\` ` +
      `or set KEEPR_APP_PATH. Searched:\n  ${candidateExecutables(repoRoot).join('\n  ')}`,
  );
}

/** Default persisted userData dir (macOS). This holds mad.db + Preferences; keychain holds the session key. */
export function defaultUserDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', USER_DATA_DIRNAME);
}

export function defaultDbPath(): string {
  return join(defaultUserDataDir(), 'mad.db');
}
