import { test as base } from '@playwright/test';
import { join } from 'node:path';
import { KeeprAppDriver } from '../driver/appDriver';
import type { AppDriverOptions, LaunchStrategy } from '../driver/types';

/** Repo root = two levels up from this file (e2e/fixtures -> e2e -> root). */
export const REPO_ROOT = join(__dirname, '..', '..');

/**
 * Launch options derived from env so the same specs run against either strategy/build:
 *   KEEPR_E2E_STRATEGY=electron|cdp   (default 'cdp' — works against the hardened build)
 *   KEEPR_APP_PATH=/path/to/binary    (override the resolved packaged executable)
 *   KEEPR_E2E_REUSE_PROFILE=0|1       (default 1 — reuse persisted session)
 */
export function optionsFromEnv(): AppDriverOptions {
  const strategy = (process.env.KEEPR_E2E_STRATEGY as LaunchStrategy) || 'cdp';
  const reuseProfile = process.env.KEEPR_E2E_REUSE_PROFILE !== '0';
  return {
    strategy,
    reuseProfile,
    executablePath: process.env.KEEPR_APP_PATH,
    artifactsDir: join(REPO_ROOT, 'e2e', '.artifacts'),
  };
}

export interface KeeprFixtures {
  driver: KeeprAppDriver;
}

/**
 * Fixture that boots the packaged app once per test and tears it down after.
 * Session reuse is the default, matching the ceremony's one-time-login model.
 */
export const test = base.extend<KeeprFixtures>({
  driver: async ({}, use) => {
    const driver = await KeeprAppDriver.launch(REPO_ROOT, optionsFromEnv());
    try {
      await use(driver);
    } finally {
      await driver.close();
    }
  },
});

export { expect } from '@playwright/test';
