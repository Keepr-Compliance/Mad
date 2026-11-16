/**
 * Keepr Cloud notice versions this build can show (BACKLOG-4243, plan §9 R11).
 * The text itself lives in the renderer copy file
 * (src/components/settings/cloudSync/keeprCloudCopy.ts); a parity test keeps
 * the two lists equal. Turning on is refused for any other version.
 */
export const SUPPORTED_NOTICE_VERSIONS: readonly number[] = [1];

export function isNoticeSupported(version: number | null | undefined): version is number {
  return typeof version === "number" && SUPPORTED_NOTICE_VERSIONS.includes(version);
}
