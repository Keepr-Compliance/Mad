/**
 * Updater Asset URL builder — pure helper for the one-click manual installer.
 * BACKLOG-1905 (SPRINT-167 Auto-Updater Resilience, Phase B)
 *
 * PURE MODULE — no Electron, fs, or network imports. Deterministic and
 * side-effect free so it can be fully unit-tested and reused from the IPC
 * handler (electron/handlers/updaterHandlers.ts) without pulling in Electron.
 *
 * Responsibility: given a target version + the user's OS/arch + the
 * electron-builder GitHub publish config, construct the canonical GitHub
 * releases *asset download URL* for the exact installer that OS/arch needs,
 * so a user hitting a failed auto-update can self-recover in one click.
 *
 * [HARD CONSTRAINT — pairs with BACKLOG-1909]
 * The owner/repo are ALWAYS read from the caller-supplied publish config
 * (package.json `build.publish`), which is the canonical
 * `Keepr-Compliance/keepr-releases`. This module must NEVER hardcode the
 * legacy `5hdaniel` owner — the shipped app-update.yml still points at
 * `5hdaniel` and only resolves via a 301 redirect (BACKLOG-1909 fixes that,
 * still pending), but the canonical owner resolves either way. See guard in
 * buildManualInstallerUrl().
 *
 * Asset naming is derived from the LIVE release convention on
 * Keepr-Compliance/keepr-releases (verified against v2.21.0), which is the
 * electron-builder default for this project's build config:
 *   - macOS arm64 (Apple Silicon): Keepr-<version>-arm64.dmg
 *   - macOS x64   (Intel):         Keepr-<version>.dmg      (NO arch suffix)
 *   - Windows x64:                 Keepr-Setup-<version>.exe (nsis artifactName)
 */

/** electron-builder GitHub publish config subset we read (from build.publish). */
export interface GithubPublishConfig {
  provider?: string;
  owner?: string;
  repo?: string;
}

/** Inputs for {@link buildManualInstallerUrl}. */
export interface ManualInstallerUrlParams {
  /** Target version to download (e.g. "2.99.0"). A leading "v" is tolerated. */
  version: string;
  /** process.platform value ("darwin" | "win32" | ...). */
  platform: NodeJS.Platform | string;
  /** process.arch value ("arm64" | "x64" | ...). */
  arch: string;
  /** electron-builder publish config (owner/repo). REQUIRED — no hardcoded fallback owner. */
  publish: GithubPublishConfig;
  /**
   * Product name used in the asset filename. Defaults to "Keepr" to match the
   * current build config; overridable for testing / future rename.
   */
  productName?: string;
}

/** The legacy owner that must never appear in a generated URL (BACKLOG-1909). */
const FORBIDDEN_LEGACY_OWNER = "5hdaniel";

/** Strip a single leading "v"/"V" from a version string, if present. */
function normalizeVersion(version: string): string {
  return version.replace(/^v/i, "").trim();
}

/**
 * Resolve the release asset filename for the given OS/arch. Returns `undefined`
 * for unsupported platform/arch combinations (caller should not open a URL).
 *
 * Naming mirrors the live release assets on Keepr-Compliance/keepr-releases:
 *   darwin + arm64 -> `${productName}-${version}-arm64.dmg`
 *   darwin + x64   -> `${productName}-${version}.dmg`
 *   win32  + *     -> `${productName}-Setup-${version}.exe`
 */
export function resolveInstallerAssetName(
  productName: string,
  version: string,
  platform: NodeJS.Platform | string,
  arch: string,
): string | undefined {
  const v = normalizeVersion(version);
  if (!v) return undefined;

  if (platform === "darwin") {
    // Apple Silicon builds carry the `-arm64` suffix; Intel (x64) does not.
    return arch === "arm64"
      ? `${productName}-${v}-arm64.dmg`
      : `${productName}-${v}.dmg`;
  }

  if (platform === "win32") {
    // nsis artifactName = `${productName}-Setup-${version}.${ext}` (arch-agnostic).
    return `${productName}-Setup-${v}.exe`;
  }

  // Linux / unsupported: no packaged installer asset to hand a one-click link for.
  return undefined;
}

/**
 * Build the canonical GitHub releases asset download URL for the exact
 * target-version installer this OS/arch needs.
 *
 * @returns The download URL, or `undefined` when the platform/arch is
 *          unsupported or required inputs are missing. Callers should guard on
 *          `undefined` and fall back to the generic Report affordance.
 * @throws Error if the publish config resolves to the forbidden legacy owner
 *         (`5hdaniel`) — this is a programming error we refuse to ship
 *         (BACKLOG-1909). The canonical owner is `Keepr-Compliance`.
 */
export function buildManualInstallerUrl(
  params: ManualInstallerUrlParams,
): string | undefined {
  const { version, platform, arch, publish } = params;
  const productName = params.productName ?? "Keepr";

  const owner = publish?.owner?.trim();
  const repo = publish?.repo?.trim();
  if (!owner || !repo) return undefined;

  // [BACKLOG-1909] Never emit a link against the legacy owner — it only works
  // via a 301 redirect and is exactly what 1909 removes. Fail loudly.
  if (owner.toLowerCase() === FORBIDDEN_LEGACY_OWNER) {
    throw new Error(
      `Refusing to build a manual installer URL for the legacy owner "${owner}". ` +
        `Use the canonical Keepr-Compliance/keepr-releases owner (see BACKLOG-1909).`,
    );
  }

  const v = normalizeVersion(version);
  if (!v) return undefined;

  const asset = resolveInstallerAssetName(productName, v, platform, arch);
  if (!asset) return undefined;

  // GitHub release asset download URL: /<owner>/<repo>/releases/download/<tag>/<asset>
  // Tag convention is `v<version>` (matches the live releases, e.g. v2.21.0).
  return `https://github.com/${owner}/${repo}/releases/download/v${v}/${asset}`;
}
