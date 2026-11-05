/**
 * @jest-environment node
 */

/**
 * BACKLOG-3200 — the release body's download table is built from the files the
 * release attaches, and a body that advertises an unattached file fails.
 *
 * Asset names are the real v2.35.0 set quoted on the backlog item
 * (Keepr-Compliance/keepr-releases v2.35.0: Keepr-2.35.0-arm64.dmg and
 * Keepr-2.35.0.dmg, no -x64.dmg). The Windows name follows package.json
 * build.nsis.artifactName "${productName}-Setup-${version}.${ext}".
 */

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.join(__dirname, "../ci/release-download-table.mjs");
const V = "2.35.0";
const MAC = [`Keepr-${V}-arm64.dmg`, `Keepr-${V}.dmg`, `Keepr-${V}-arm64-mac.zip`, `Keepr-${V}-mac.zip`, `Keepr-${V}.dmg.blockmap`, "latest-mac.yml"];
const WIN = [`Keepr-Setup-${V}.exe`, `Keepr-Setup-${V}.exe.blockmap`, "latest.yml"];

// The body release.yml carried before this change, rendered for V.
const OLD_BODY = `### Downloads

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | \`Keepr-${V}-arm64.dmg\` |
| macOS (Intel) | \`Keepr-${V}-x64.dmg\` |
| Windows | \`Keepr-Setup-${V}.exe\` |
`;

let dir = "";
const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

function artifacts(mac: string[], win: string[]) {
  const root = mkdtempSync(path.join(dir, "a-"));
  const m = path.join(root, "release-macos");
  const w = path.join(root, "release-windows");
  mkdirSync(m);
  mkdirSync(w);
  mac.forEach((f) => writeFileSync(path.join(m, f), ""));
  win.forEach((f) => writeFileSync(path.join(w, f), ""));
  return { m, w, out: path.join(root, "body.md") };
}
const write = (a: ReturnType<typeof artifacts>) =>
  run(["--write", "--version", V, "--mac-dir", a.m, "--win-dir", a.w, "--out", a.out]);
// softprops/action-gh-release `assets` output shape: objects with a name.
const assetsJson = (names: string[]) => JSON.stringify(names.map((name, id) => ({ id, name })));

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "keepr-3200-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("BACKLOG-3200 --write", () => {
  it("advertises the unsuffixed DMG as the Intel build", () => {
    const a = artifacts(MAC, WIN);
    const r = write(a);
    expect(r.status).toBe(0);
    const body = readFileSync(a.out, "utf8");
    expect(body).toContain(`| macOS (Intel) | \`Keepr-${V}.dmg\` |`);
    expect(body).toContain(`| macOS (Apple Silicon) | \`Keepr-${V}-arm64.dmg\` |`);
    expect(body).toContain(`| Windows | \`Keepr-Setup-${V}.exe\` |`);
    expect(body).not.toContain("-x64.dmg");
  });

  it("follows the build if electron-builder ever suffixes x64", () => {
    const a = artifacts([`Keepr-${V}-arm64.dmg`, `Keepr-${V}-x64.dmg`], WIN);
    expect(write(a).status).toBe(0);
    expect(readFileSync(a.out, "utf8")).toContain(`| macOS (Intel) | \`Keepr-${V}-x64.dmg\` |`);
  });

  it.each([
    ["no Intel DMG", [`Keepr-${V}-arm64.dmg`], WIN, /Intel/],
    ["no arm64 DMG", [`Keepr-${V}.dmg`], WIN, /arm64/],
    ["two Intel DMGs", [`Keepr-${V}-arm64.dmg`, `Keepr-${V}.dmg`, `Keepr-${V}-x64.dmg`], WIN, /Intel/],
    ["no Windows installer", MAC, ["latest.yml"], /Setup/],
  ])("FAILS with %s", (_l, mac, win, msg) => {
    const r = write(artifacts(mac as string[], win as string[]));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(msg as RegExp);
  });
});

describe("BACKLOG-3200 --check", () => {
  it("passes when every advertised file is attached", () => {
    const a = artifacts(MAC, WIN);
    write(a);
    const r = run(["--check", "--body", a.out, "--assets", assetsJson([...MAC, ...WIN])]);
    expect(r.stdout).toMatch(/OK — all 3 advertised downloads are attached/);
    expect(r.status).toBe(0);
  });

  it("FAILS on the old hand-written body against the real v2.35.0 assets", () => {
    const body = path.join(dir, "old.md");
    writeFileSync(body, OLD_BODY);
    const r = run(["--check", "--body", body, "--assets", assetsJson([...MAC, ...WIN])]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Keepr-${V}-x64.dmg`);
  });

  it("FAILS when nothing was attached", () => {
    const a = artifacts(MAC, WIN);
    write(a);
    expect(run(["--check", "--body", a.out, "--assets", "[]"]).status).toBe(1);
  });

  it("FAILS when the body has no download table (reads nothing)", () => {
    const body = path.join(dir, "empty.md");
    writeFileSync(body, "## Keepr\n");
    expect(run(["--check", "--body", body, "--assets", assetsJson(MAC)]).status).toBe(1);
  });

  it("accepts a plain array of names", () => {
    const a = artifacts(MAC, WIN);
    write(a);
    expect(run(["--check", "--body", a.out, "--assets", JSON.stringify([...MAC, ...WIN])]).status).toBe(0);
  });
});
