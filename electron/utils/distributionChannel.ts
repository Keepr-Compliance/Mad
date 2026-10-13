/**
 * BACKLOG-3927: which distribution channel this build belongs to.
 *
 * "website" — the installer downloaded from keeprcompliance.com. It bundles
 *             Apple Mobile Device Support and installs it with consent.
 * "store"   — the installer listed in the Microsoft Store. Store policy
 *             10.2.4.2 does not allow drivers that Microsoft did not provide,
 *             so this build ships no Apple driver and never downloads or
 *             installs one. iPhone setup sends the user to Apple's own
 *             "Apple Devices" app in the Microsoft Store instead.
 *
 * The channel is fixed at build time: the Store release run packages with
 * `--config.extraMetadata.distributionChannel=store`, which electron-builder
 * writes into the package.json inside app.asar. Anything else is "website".
 *
 * This module is PURE (no `electron` import) so the preload bundle can import
 * the argv token. Main reads the package field itself and passes it in.
 */

export type DistributionChannel = "website" | "store";

/** Field name electron-builder's extraMetadata writes into package.json. */
export const DISTRIBUTION_CHANNEL_FIELD = "distributionChannel";

/**
 * Dev-only override (`npm run dev` has no packaged package.json field).
 * Ignored in packaged builds, so a user environment variable can never turn a
 * website build into a Store build or the reverse.
 */
export const DISTRIBUTION_CHANNEL_ENV = "KEEPR_DISTRIBUTION_CHANNEL";

/**
 * Passed to the renderer's preload via `webPreferences.additionalArguments`,
 * present ONLY in the Store build. Matched exactly — absent means "website".
 */
export const STORE_BUILD_ARGV_TOKEN = "--keepr-distribution=store";

/** Microsoft Store product id of Apple's "Apple Devices" app (publisher Apple Inc.). */
export const APPLE_DEVICES_STORE_PRODUCT_ID = "9NP83LWLPZ9K";
export const APPLE_DEVICES_STORE_URL = `ms-windows-store://pdp/?ProductId=${APPLE_DEVICES_STORE_PRODUCT_ID}`;
export const APPLE_DEVICES_WEB_URL = `https://apps.microsoft.com/detail/${APPLE_DEVICES_STORE_PRODUCT_ID}`;

export function resolveDistributionChannel(input: {
  packageField: unknown;
  envOverride: string | undefined;
  isPackaged: boolean;
}): DistributionChannel {
  if (input.isPackaged) {
    return input.packageField === "store" ? "store" : "website";
  }
  if (input.envOverride === "store") return "store";
  return input.packageField === "store" ? "store" : "website";
}

/** Exact match of the argv token. */
export function argvHasStoreBuildToken(argv: readonly string[]): boolean {
  return argv.includes(STORE_BUILD_ARGV_TOKEN);
}
