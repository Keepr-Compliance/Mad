/**
 * BACKLOG-2987 — THE PAIRING SCREENS MUST NOT REGISTER ON THEIR OWN.
 *
 * `deviceIdentity.test.ts` proves the round trip re-presents a held identity.
 * It cannot prove the two pairing SCREENS use it — and that is exactly where
 * the defect lived: the logic was right in one place (the desktop already
 * reused a UUID-shaped claim) and both screens simply did not send one.
 *
 * This suite asserts the IMPORT GRAPH, which is the property at stake: no
 * pairing surface may reach `registerDevice` directly, because doing so is how
 * you end up choosing a `deviceId` by hand, and both hand-written copies chose
 * `data.deviceName`. `registerWithStoredIdentity` is the only permitted door,
 * and `services/deviceIdentity.ts` is the only file behind it.
 *
 * A TEXT SCAN IS THE RIGHT INSTRUMENT HERE, unusually. The house rule is to
 * derive sets by EXECUTION rather than by grep, because grep finds a token and
 * not a property. Here the property IS textual: "does this file contain an
 * import of this symbol from this module". There is nothing to execute — a
 * rendered screen would prove the call happened on one code path, not that no
 * other path can bypass it.
 *
 * MUTATION THAT MUST GO RED (run, not asserted — see the PR body):
 *   add `import { registerDevice } from '../../services/syncService';` back to
 *   `app/onboarding/pair-device.tsx`. The first case fails and names the file.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const APP_DIR = join(__dirname, '..', '..', 'app');
const SERVICES_DIR = join(__dirname, '..');

/** Every `.ts`/`.tsx` file under `dir`, excluding test directories. */
function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFilesUnder(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Does `source` import `symbol` from a module path ending in `moduleSuffix`?
 *
 * Matches the `import { a, b } from '…/x'` form, which is the only form this
 * codebase uses for these modules. A dynamic `require` would slip past — stated
 * so the limit is known rather than assumed away; there are none today and the
 * companion is `import`-only.
 */
function importsSymbolFrom(
  source: string,
  symbol: string,
  moduleSuffix: string,
): boolean {
  const pattern = new RegExp(
    `import\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${moduleSuffix}['"]`,
    's',
  );
  return pattern.test(source);
}

describe('BACKLOG-2987 pairing call sites', () => {
  const appFiles = sourceFilesUnder(APP_DIR);

  it('finds the pairing screens (guard against an empty sweep proving nothing)', () => {
    // An empty or mis-rooted file list would make every assertion below pass
    // vacuously — the "check whose inputs cannot separate pass from fail" shape.
    expect(appFiles.length).toBeGreaterThan(5);
    const names = appFiles.map((f) => f.replace(APP_DIR, ''));
    expect(names.some((n) => n.endsWith('home.tsx'))).toBe(true);
    expect(names.some((n) => n.endsWith('pair-device.tsx'))).toBe(true);
  });

  it('no screen imports registerDevice directly', () => {
    const offenders = appFiles.filter((file) =>
      importsSymbolFrom(readFileSync(file, 'utf8'), 'registerDevice', 'syncService'),
    );
    expect(offenders.map((f) => f.replace(APP_DIR, 'app'))).toEqual([]);
  });

  it('both pairing screens go through registerWithStoredIdentity', () => {
    const pairingScreens = appFiles.filter(
      (f) => f.endsWith('home.tsx') || f.endsWith('pair-device.tsx'),
    );
    expect(pairingScreens).toHaveLength(2);
    for (const file of pairingScreens) {
      const source = readFileSync(file, 'utf8');
      expect(
        importsSymbolFrom(source, 'registerWithStoredIdentity', 'deviceIdentity'),
      ).toBe(true);
    }
  });

  it('deviceIdentity is the only service that calls registerDevice', () => {
    const offenders = sourceFilesUnder(SERVICES_DIR)
      .filter((f) => !f.endsWith('deviceIdentity.ts'))
      .filter((file) =>
        importsSymbolFrom(readFileSync(file, 'utf8'), 'registerDevice', 'syncService'),
      );
    expect(offenders.map((f) => f.replace(SERVICES_DIR, 'services'))).toEqual([]);
  });
});
