/**
 * BACKLOG-3927 / BACKLOG-3689: scripts/ci/check-pe-signatures.ps1 app-root floor.
 * Both channels now ship the same 11 iPhone tool files, so both app roots hold the same PE
 * set (Store measured 25) and share one floor, 21. -Channel is still accepted.
 *
 * Runs the real script under pwsh with -HeaderOnly and a fake 7z that "unpacks" a synthetic
 * tree. -HeaderOnly always exits 1, so the assertion is on the floor error line, not the
 * exit code. Skipped when pwsh is absent or on Windows; the static wiring checks always run.
 */
import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const REPO = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(REPO, "scripts", "ci", "check-pe-signatures.ps1");
const RELEASE = readFileSync(path.join(REPO, ".github", "workflows", "release.yml"), "utf8");
// The fake 7z is a bash script, so the behavioural half runs on POSIX runners only.
const pwsh = process.platform !== "win32" && spawnSync("pwsh", ["-NoProfile", "-Command", "1"]).status === 0;

// Fake 7z: "x -y -o<dest> -- <archive>". Builds the tree the script expects.
const FAKE_7Z = `#!/bin/bash
for a in "$@"; do case "$a" in -o*) dest="\${a#-o}";; esac; done
archive="\${@: -1}"
mkdir -p "$dest"
pe() { printf 'MZ' > "$1"; head -c 254 /dev/zero >> "$1"; printf '\\x40' | dd of="$1" bs=1 seek=60 conv=notrunc 2>/dev/null; printf 'PE\\0\\0' | dd of="$1" bs=1 seek=64 conv=notrunc 2>/dev/null; }
case "$(basename "$archive")" in
  app-*.7z) for i in $(seq 1 "$APP_PE"); do pe "$dest/a$i.dll"; done ;;
  Uninstall*.exe) for i in 1 2 3 4; do pe "$dest/u$i.dll"; done ;;
  *) for i in 1 2 3 4 5 6; do pe "$dest/o$i.dll"; done; pe "$dest/Uninstall.exe"; : > "$dest/app-64.7z" ;;
esac
`;

function run(channel: string | null, appPe: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pefloor-"));
  try {
    const sevenZ = path.join(dir, "fake7z.sh");
    writeFileSync(sevenZ, FAKE_7Z);
    chmodSync(sevenZ, 0o755);
    const installer = path.join(dir, "Keepr-Setup-1.0.0.exe");
    writeFileSync(installer, "x");
    const work = path.join(dir, "work");
    mkdirSync(work);
    const args = ["-NoProfile", "-File", SCRIPT, "-Installer", installer, "-WorkDir", work, "-SevenZip", sevenZ, "-HeaderOnly"];
    if (channel) args.push("-Channel", channel);
    const r = spawnSync("pwsh", args, { encoding: "utf8", env: { ...process.env, APP_PE: String(appPe) } });
    return `${r.stdout}${r.stderr}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const floorError = (out: string) => /root 'app' has \d+ PE files, floor is \d+/.exec(out)?.[0] ?? null;

describe("check-pe-signatures per-channel app floor (BACKLOG-3927)", () => {
  it("release.yml passes the channel to the PE check", () => {
    const step = RELEASE.split("- name: Verify every PE file is signed (BACKLOG-3533)")[1].split("- name:")[0];
    expect(step).toContain("KEEPR_CHANNEL: ${{ inputs.channel == 'store' && 'store' || 'website' }}");
    expect(step).toContain("-Channel $env:KEEPR_CHANNEL");
  });

  (pwsh ? describe : describe.skip)("behaviour under pwsh", () => {
    it("website (default): 21 passes, 20 fails with floor 21", () => {
      expect(floorError(run(null, 21))).toBeNull();
      expect(floorError(run(null, 20))).toBe("root 'app' has 20 PE files, floor is 21");
    });
    it("explicit website behaves as the default", () => {
      expect(floorError(run("website", 21))).toBeNull();
      expect(floorError(run("website", 20))).toBe("root 'app' has 20 PE files, floor is 21");
    });
    it("store: 21 passes, 20 fails with floor 21", () => {
      expect(floorError(run("store", 21))).toBeNull();
      expect(floorError(run("store", 20))).toBe("root 'app' has 20 PE files, floor is 21");
    });
  });
});
