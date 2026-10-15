import path from "path";

/**
 * BACKLOG-3803: the third-party notices Keepr ships. Generated from
 * resources/third-party/components.json by scripts/third-party/generate-notices.js
 * and packaged by the `resources/third-party` extraResources entry in package.json.
 *
 * The .txt (notices plus every licence text) is opened rather than the .md because
 * Windows has no default app for .md files.
 */
export const THIRD_PARTY_NOTICES_FILE = "THIRD_PARTY_NOTICES.txt";

/** <resources>/third-party/THIRD_PARTY_NOTICES.txt, or the repo's copy in development. */
export function thirdPartyNoticesPath(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  return opts.isPackaged
    ? path.join(opts.resourcesPath, "third-party", THIRD_PARTY_NOTICES_FILE)
    : path.join(opts.appPath, "resources", "third-party", THIRD_PARTY_NOTICES_FILE);
}
