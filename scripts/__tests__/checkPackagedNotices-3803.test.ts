/**
 * BACKLOG-3803: the release gate that fails when a packaged app lacks the licence files.
 * Runs the real script (scripts/ci/check-packaged-notices.mjs) against fixture directories.
 */
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.resolve(__dirname, "..", "ci", "check-packaged-notices.mjs");

const MAC = [
  "Contents/Resources/third-party/LICENSES.chromium.html",
  "Contents/Resources/third-party/LICENSE.electron.txt",
  "Contents/Resources/third-party/THIRD_PARTY_NOTICES.txt",
];
const WIN = ["LICENSE.electron.txt", "LICENSES.chromium.html", "resources/third-party/THIRD_PARTY_NOTICES.txt"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "pkg-notices-3803-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fill = (files: string[], content = "x") => {
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), content);
  }
};
const run = (platform: string) => spawnSync(process.execPath, [SCRIPT, platform, dir], { encoding: "utf8" });

describe.each([
  ["mac", MAC],
  ["win", WIN],
])("check-packaged-notices %s", (platform, files) => {
  it("passes when every file is present", () => {
    fill(files);
    const r = run(platform);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.each(files.map((f) => [f]))("fails naming the file when %s is missing", (missing) => {
    fill(files.filter((f) => f !== missing));
    const r = run(platform);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`missing: ${missing}`);
  });

  it("fails when a file is empty", () => {
    fill(files);
    writeFileSync(path.join(dir, files[0]), "");
    const r = run(platform);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`empty: ${files[0]}`);
  });

  it("fails on an empty package directory listing every file", () => {
    const r = run(platform);
    expect(r.status).toBe(1);
    for (const f of files) expect(r.stderr).toContain(f);
  });
});
