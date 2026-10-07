/**
 * BACKLOG-3363: Windows-on-ARM predicate + argv token.
 *
 * MEASURED rows: transcribed verbatim from the Step 0 checkpoint probe (the
 * STEP 0 CHECKPOINT comment on BACKLOG-3363), Electron 38.8.6 on an
 * Apple M1 Max:
 *   x64 under Rosetta: {"platform":"darwin","process_arch":"x64","os_arch":"x64","os_machine":"x86_64","runningUnderARM64Translation":true}
 *   native arm64:      {"platform":"darwin","process_arch":"arm64","os_arch":"arm64","os_machine":"arm64","runningUnderARM64Translation":false}
 *
 * DERIVED rows: no Windows ARM64 host; the measured values with `platform`
 * substituted to win32. Mechanism traced, not measured: Electron
 * shell/browser/api/electron_api_app.cc:1639 -> Chromium base/win/windows_version.cc
 * OSInfo::IsRunningEmulatedOnArm64() (IsWow64Process2 native machine == ARM64).
 * Replace with a verbatim row once the first real ARM PC reports its
 * host_architecture diagnostics.
 */
import {
  isWindowsArm64,
  argvHasWindowsArm64Token,
  WINDOWS_ARM64_ARGV_TOKEN,
} from "../windowsArm64";

type Row = {
  label: string;
  platform: string;
  arch: string;
  translated: boolean | undefined;
  expected: boolean;
};

const ROWS: Row[] = [
  // MEASURED (macOS)
  { label: "MEASURED — Apple Silicon Mac, x64 DMG under Rosetta", platform: "darwin", arch: "x64", translated: true, expected: false },
  { label: "MEASURED — Apple Silicon Mac, native arm64 build", platform: "darwin", arch: "arm64", translated: false, expected: false },
  // DERIVED (Windows) — no Windows ARM64 host; platform substituted
  { label: "DERIVED — Snapdragon PC, x64 Keepr under emulation", platform: "win32", arch: "x64", translated: true, expected: true },
  { label: "DERIVED — Snapdragon PC, future native arm64 Keepr", platform: "win32", arch: "arm64", translated: false, expected: true },
  { label: "DERIVED — Intel/AMD PC, x64 Keepr", platform: "win32", arch: "x64", translated: false, expected: false },
  // runtime without the property (= jest's electron mock, old runtimes)
  { label: "win32 x64, runningUnderARM64Translation undefined", platform: "win32", arch: "x64", translated: undefined, expected: false },
  // linux: locks the win32 short-circuit
  { label: "linux x64, translation true", platform: "linux", arch: "x64", translated: true, expected: false },
  { label: "linux x64, translation false", platform: "linux", arch: "x64", translated: false, expected: false },
];

describe("isWindowsArm64 (BACKLOG-3363)", () => {
  it.each(ROWS)("$label -> $expected", ({ platform, arch, translated, expected }) => {
    expect(isWindowsArm64(platform, arch, translated)).toBe(expected);
  });
});

describe("argvHasWindowsArm64Token (BACKLOG-3363 C4)", () => {
  it("true only when the exact token is present", () => {
    expect(argvHasWindowsArm64Token(["electron", ".", WINDOWS_ARM64_ARGV_TOKEN])).toBe(true);
  });
  it("absent -> false", () => {
    expect(argvHasWindowsArm64Token(["electron", "."])).toBe(false);
  });
  it.each([
    "--keepr-windows-arm64=0",
    "--keepr-windows-arm64",
    "--keepr-windows-arm64=10",
    "x--keepr-windows-arm64=1",
  ])("near-miss %s -> false", (arg) => {
    expect(argvHasWindowsArm64Token(["electron", arg])).toBe(false);
  });
});
