/**
 * BACKLOG-3363: Windows on ARM (e.g. Snapdragon) detection.
 *
 * Apple's iPhone USB driver is x64-only and cannot load on an ARM64 Windows
 * kernel, so iPhone USB sync can never work on these PCs. Keepr ships as x64
 * and runs there under emulation, which makes `process.arch` and `os.machine()`
 * report x64 — neither can tell an ARM PC apart. Electron's
 * `app.runningUnderARM64Translation` can: on Windows it is
 * `base::win::OSInfo::IsRunningEmulatedOnArm64()` (IsWow64Process2 native
 * machine == ARM64). Every failure branch of that call returns false, i.e.
 * "supported" — today's behaviour.
 *
 * This module is PURE (no `electron` import) so the preload bundle can import
 * the argv token without pulling in main-only APIs. Callers in main read
 * `app.runningUnderARM64Translation` themselves and pass it in.
 */

/**
 * Passed to the renderer's preload via `webPreferences.additionalArguments`,
 * present ONLY when the host is Windows on ARM. Matched exactly (never by
 * prefix/substring) — absent means false.
 */
export const WINDOWS_ARM64_ARGV_TOKEN = "--keepr-windows-arm64=1";

/**
 * True when this process runs on a Windows ARM64 PC: either an x64 build under
 * emulation (`runningUnderARM64Translation`), or a native arm64 build (which
 * still could not load the x64 driver).
 *
 * The `platform === "win32"` term is load-bearing: an x64 macOS build under
 * Rosetta also reports `runningUnderARM64Translation: true`, and USB sync works
 * there.
 */
export function isWindowsArm64(
  platform: string,
  arch: string,
  runningUnderARM64Translation: boolean | undefined,
): boolean {
  return (
    platform === "win32" &&
    (runningUnderARM64Translation === true || arch === "arm64")
  );
}

/** Exact match of the argv token. */
export function argvHasWindowsArm64Token(argv: readonly string[]): boolean {
  return argv.includes(WINDOWS_ARM64_ARGV_TOKEN);
}
