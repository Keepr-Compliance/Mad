/**
 * BACKLOG-3927: main-process reader for the build's distribution channel.
 * See electron/utils/distributionChannel.ts for what the channels mean.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import log from "electron-log";
import {
  DISTRIBUTION_CHANNEL_ENV,
  DISTRIBUTION_CHANNEL_FIELD,
  resolveDistributionChannel,
  type DistributionChannel,
} from "../utils/distributionChannel";

let cached: DistributionChannel | null = null;

function readPackageField(): unknown {
  try {
    // Inside a packaged app this is app.asar/package.json, which Electron's
    // fs reads transparently. electron-builder's extraMetadata lands here.
    const pkgPath = path.join(app.getAppPath(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    return pkg[DISTRIBUTION_CHANNEL_FIELD];
  } catch (error) {
    log.warn("[DistributionChannel] Could not read package.json; assuming website", error);
    return undefined;
  }
}

/** The channel this build was packaged for. Read once, then cached. */
export function getDistributionChannel(): DistributionChannel {
  if (cached) return cached;
  cached = resolveDistributionChannel({
    packageField: readPackageField(),
    envOverride: process.env[DISTRIBUTION_CHANNEL_ENV],
    isPackaged: app.isPackaged,
  });
  log.info(`[DistributionChannel] ${cached}`);
  return cached;
}

/** True in the Microsoft Store build (no bundled or downloaded Apple driver). */
export function isStoreBuild(): boolean {
  return getDistributionChannel() === "store";
}

/** Test seam: forget the cached value. */
export function resetDistributionChannelCacheForTests(): void {
  cached = null;
}
