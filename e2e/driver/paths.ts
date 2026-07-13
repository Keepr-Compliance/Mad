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

/**
 * Resolve the local `electron` binary shipped in node_modules — the executable the UNPACKAGED
 * launcher runs (BACKLOG-1940 pivot). This is Electron itself (default fuses → inspector works,
 * so `_electron.launch()` attaches), NOT a packaged/codesigned .app. It runs the repo's built
 * `dist-electron/main.js` (resolved via the repo `.` entry). Override with KEEPR_ELECTRON_BIN.
 */
export function resolveElectronBinary(repoRoot: string, override?: string): string {
  const fromEnv = override ?? process.env.KEEPR_ELECTRON_BIN;
  if (fromEnv) return fromEnv;
  const bin = join(repoRoot, 'node_modules', '.bin', 'electron');
  if (!existsSync(bin)) {
    throw new Error(
      `[keepr-e2e] Local electron binary not found at ${bin}. Run \`npm install\` in the repo root.`,
    );
  }
  return bin;
}

/**
 * The built main-process entry the unpackaged launcher loads (BACKLOG-1940). Electron is pointed at
 * the repo root (`.`), which resolves package.json "main": "electron/main.js" → but the BUILT entry
 * lives at dist-electron/main.js (tsc outDir). We assert the built entry exists so a missing
 * `npm run build` fails FAST with an actionable message (→ HARNESS_ERROR) rather than a blank window.
 */
export function resolveBuiltMainEntry(repoRoot: string): string {
  const entry = join(repoRoot, 'dist-electron', 'main.js');
  if (!existsSync(entry)) {
    throw new Error(
      `[keepr-e2e] Built main entry not found at ${entry}. Build it with \`npm run build\` first.`,
    );
  }
  return entry;
}

/** Default persisted userData dir (macOS). This holds mad.db + Preferences; keychain holds the session key. */
export function defaultUserDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', USER_DATA_DIRNAME);
}

export function defaultDbPath(): string {
  return join(defaultUserDataDir(), 'mad.db');
}
