/**
 * BACKLOG-3927: the Microsoft Store build never updates itself. The Store
 * delivers its updates; the in-app updater would replace it with the website
 * build. Every auto-updater entry point asks this module first.
 */

import log from "electron-log";
import type { UpdateCheckResult } from "electron-updater";
import { isStoreBuild } from "./distributionChannelService";

/** Shown wherever a self-update would otherwise start. */
export const STORE_UPDATES_MESSAGE = "Updates for this version of Keepr come from the Microsoft Store.";

/** True when the in-app updater must not contact the update feed. */
export function isSelfUpdateDisabled(): boolean {
  return isStoreBuild();
}

/**
 * The only way main.ts starts an automatic update check (startup and the
 * periodic timer). Returns null, and contacts nothing, in the Store build.
 */
export function checkForUpdatesUnlessStore(
  updater: { checkForUpdates(): Promise<UpdateCheckResult | null> },
  trigger: "startup" | "periodic",
): Promise<UpdateCheckResult | null> | null {
  if (isSelfUpdateDisabled()) {
    log.info(`[AutoUpdater] Store build: ${trigger} update check skipped (updates come from the Microsoft Store)`);
    return null;
  }
  return updater.checkForUpdates();
}
