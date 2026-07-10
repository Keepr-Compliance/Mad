/**
 * H2 app-driver component (BACKLOG-1849) — implements the H1 ceremony contract
 * `AppDriverComponent` from `../types` (BACKLOG-1848). This is the real driver the
 * runner's `drive` stage uses; it wraps the packaged-app driver from `e2e/driver`.
 *
 * REGISTRY SWAP (coordinated follow-up): `components/registry.ts` still wires `stubDriver`
 * as the default so H1's wiring smoke test + runner unit tests stay stub-only. Swap
 * `driver: stubDriver` -> `driver: playwrightElectronDriver` when live E2E is turned on
 * (needs the notarized QA build + one-time login — see e2e/README.md).
 *
 * Side-effect safety: honors H1's `CeremonyOptions` — in non-live / dry-run / skip-driver
 * mode the app is NOT booted and the stage reports `stub`/`skipped`, so a default
 * `qa:ceremony` run touches no app or filesystem.
 */
import { KeeprAppDriver } from '../../../../e2e/driver/appDriver';
import type { AppDriverOptions } from '../../../../e2e/driver/types';
import type { AppDriverComponent, CeremonyContext, StageResult } from '../types';

/** Launch options from env so the runner works against a QA-fused build or the hardened build. */
function driverOptions(): AppDriverOptions {
  return {
    strategy: (process.env.KEEPR_E2E_STRATEGY as AppDriverOptions['strategy']) ?? 'electron',
    reuseProfile: process.env.KEEPR_E2E_REUSE_PROFILE !== '0',
    executablePath: process.env.KEEPR_APP_PATH,
  };
}

function stage(status: StageResult['status'], startedMs: number, detail: string): StageResult {
  return { stage: 'drive', status, durationMs: Date.now() - startedMs, detail };
}

export const playwrightElectronDriver: AppDriverComponent = {
  name: 'playwright-electron-driver',
  async drive(ctx: CeremonyContext): Promise<StageResult> {
    const started = Date.now();

    if (ctx.options.skipDriver) {
      return stage('skipped', started, 'drive stage skipped (--skip-driver)');
    }
    if (!ctx.options.live || ctx.options.dryRun) {
      ctx.logger.warn('[H2] app driver not engaged (needs --live); skipping packaged-app boot.');
      return stage('stub', started, 'app not booted (stub/dry-run mode; pass --live to drive the packaged app)');
    }

    let driver: KeeprAppDriver | undefined;
    try {
      driver = await KeeprAppDriver.launch(ctx.repoRoot, driverOptions());
      const sessionReused = await driver.isSessionReused();
      ctx.logger.info(`[H2] booted (strategy=${driver.strategy}, sessionReused=${sessionReused})`);

      await driver.completeOnboarding({ skip: true, provider: ctx.scenario.source });
      if ((await driver.detectState()) !== 'ready') {
        return stage('fail', started, 'app did not reach the ready state after onboarding');
      }

      await driver.gotoTransaction(ctx.scenario.transaction.address);
      // Exercise the deterministic control both ways; exact counts are asserted by H3/H5.
      await driver.setAddressFilter(false);
      await driver.setAddressFilter(true);

      return stage(
        'pass',
        started,
        `drove ${ctx.scenario.transaction.label} (strategy=${driver.strategy}, sessionReused=${sessionReused})`,
      );
    } catch (err) {
      return stage('fail', started, String(err).split('\n')[0].slice(0, 240));
    } finally {
      if (driver) await driver.close();
    }
  },
};
