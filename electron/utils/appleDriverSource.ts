/**
 * BACKLOG-3927: hidden test override for WHICH source of Apple Mobile Device
 * Support counts as ready.
 *
 *   KEEPR_APPLE_DRIVER_SOURCE=auto         (default) either source counts
 *   KEEPR_APPLE_DRIVER_SOURCE=msi          only Apple's MSI (registry + Windows service)
 *   KEEPR_APPLE_DRIVER_SOURCE=appledevices only Apple's "Apple Devices" Store app
 *
 * It lets a tester see each source's screens on a PC that has both, without
 * uninstalling anything. It ONLY changes which source `checkAppleDrivers`
 * consults. It is never read by the install, download or bundled-installer
 * paths (`getBundledDriverPath`, `installAppleDrivers`, `downloadAppleDrivers`,
 * the `drivers:*` IPC handlers): it cannot install, download or unlock
 * anything, in either channel. It is never shown in the UI, the support
 * ticket or diagnostics; it is logged once in main.log when it is not "auto".
 *
 * Gate:
 *  - unpackaged (`npm run dev`): honoured.
 *  - packaged: honoured ONLY when `KEEPR_QA_OVERRIDES=1` is also set.
 *    There is no earlier packaged-with-QA-flag override in this repo to copy.
 *    The two nearest patterns are `KEEPR_E2E` (main.ts `isE2EServeDistMode`:
 *    `!app.isPackaged && KEEPR_E2E === "1"`, dead in any packaged build) and
 *    `KEEPR_DISTRIBUTION_CHANNEL` (utils/distributionChannel.ts: dev only,
 *    ignored when packaged). A locally packaged QA build has to reach this
 *    override, so it takes the second, explicit flag instead of being dev-only.
 *
 * PURE (no `electron` import): main passes `isPackaged` in.
 */

export type AppleDriverSource = "auto" | "msi" | "appledevices";

export const APPLE_DRIVER_SOURCE_ENV = "KEEPR_APPLE_DRIVER_SOURCE";
export const QA_OVERRIDES_ENV = "KEEPR_QA_OVERRIDES";

export function resolveAppleDriverSource(input: {
  envValue: string | undefined;
  qaFlag: string | undefined;
  isPackaged: boolean;
}): AppleDriverSource {
  if (input.isPackaged && input.qaFlag !== "1") return "auto";
  const v = (input.envValue ?? "").trim().toLowerCase();
  if (v === "msi" || v === "appledevices") return v;
  return "auto";
}
