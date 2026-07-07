/**
 * H1 integration adapter — implements the ceremony runner's app-driver component
 * (BACKLOG-1849 driver → BACKLOG-1848 runner).
 *
 * PARALLEL-WORK NOTE: H1 (BACKLOG-1848) publishes the canonical component interfaces in
 * `scripts/qa/harness/types.ts`. That file is not yet merged to int/qa-harness-p1, so this
 * adapter declares the expected shapes INLINE (structurally compatible) to keep this PR
 * independently type-checkable. AT H1 MERGE: delete the local interfaces below and replace with
 *   `import type { AppDriverComponent, CeremonyContext, DriveResult } from '../types';`
 * then reconcile any signature drift. See the driver's public API in e2e/driver/types.ts.
 */
import { join } from 'node:path';
import { KeeprAppDriver } from '../../../../e2e/driver/appDriver';
import { defaultDbPath } from '../../../../e2e/driver/paths';
import type { AppDriverOptions } from '../../../../e2e/driver/types';

// ---- Local mirror of H1's contract (replace with import at integration) ------------------
export interface CeremonyContext {
  repoRoot: string;
  scenario: {
    transactionAddress: string;
    provider?: 'outlook' | 'gmail';
  };
  /** Where the export should be written (H5 diffs against the canonical manifest). */
  exportDestDir?: string;
  artifactsDir?: string;
}

export interface DriveResult {
  ready: boolean;
  sessionReused: boolean;
  userDataDir: string;
  /** Encrypted local DB the H3 set-diff asserter reads after the drive. */
  dbPath: string;
  exportTriggered: boolean;
  exportDestDir?: string;
}

export interface AppDriverComponent {
  readonly name: string;
  drive(ctx: CeremonyContext): Promise<DriveResult>;
}
// -----------------------------------------------------------------------------------------

/**
 * Boots the packaged app (reusing the persisted session), drives the scenario steps the
 * runner needs (onboarding → navigate → filter cycle → export), and returns the paths the
 * DB / export asserters consume. Launch strategy is env-driven (KEEPR_E2E_STRATEGY) so the
 * same runner works against a QA-fused build (electron) or the hardened build (cdp).
 */
export function createPlaywrightElectronDriver(overrides: Partial<AppDriverOptions> = {}): AppDriverComponent {
  return {
    name: 'playwright-electron',
    async drive(ctx: CeremonyContext): Promise<DriveResult> {
      const opts: AppDriverOptions = {
        strategy: (process.env.KEEPR_E2E_STRATEGY as AppDriverOptions['strategy']) ?? 'electron',
        reuseProfile: process.env.KEEPR_E2E_REUSE_PROFILE !== '0',
        executablePath: process.env.KEEPR_APP_PATH,
        artifactsDir: ctx.artifactsDir,
        ...overrides,
      };
      const driver = await KeeprAppDriver.launch(ctx.repoRoot, opts);
      try {
        const sessionReused = await driver.isSessionReused();
        await driver.completeOnboarding({ skip: true, provider: ctx.scenario.provider });
        const ready = (await driver.detectState()) === 'ready';

        await driver.gotoTransaction(ctx.scenario.transactionAddress);
        // Exercise the deterministic control both ways; the runner's asserters read counts.
        await driver.setAddressFilter(false);
        await driver.setAddressFilter(true);

        let exportTriggered = false;
        const exportDestDir = ctx.exportDestDir;
        if (exportDestDir) {
          const res = await driver.triggerExport({ format: 'folder', destDir: exportDestDir });
          exportTriggered = res.triggered;
        }

        return {
          ready,
          sessionReused,
          userDataDir: driver.userDataDir(),
          dbPath: join(driver.userDataDir(), 'mad.db') || defaultDbPath(),
          exportTriggered,
          exportDestDir,
        };
      } finally {
        await driver.close();
      }
    },
  };
}
