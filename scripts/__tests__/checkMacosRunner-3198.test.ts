/**
 * @jest-environment node
 */

/**
 * BACKLOG-3198 — every macOS job runs on the pinned label, and the release
 * refuses a runner whose macOS version differs from the recorded one.
 */

import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const ROOT = path.join(__dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/ci/check-macos-runner.mjs");
const CONFIG = JSON.parse(readFileSync(path.join(ROOT, ".github/macos-runner.json"), "utf8"));
let dir = "";

const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
const write = (name: string, body: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
};
const host = (product: string, build: string, extra: string[] = []) =>
  run(["--host", "--observed-product", product, "--observed-build", build, ...extra]);

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "keepr-3198-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("BACKLOG-3198 check-macos-runner --workflows", () => {
  it("passes on the repo's release.yml and ci.yml (4 macOS jobs)", () => {
    const r = run(["--workflows"]);
    expect(r.stdout).toMatch(/OK — 4 macOS runs-on use macos-26/);
    expect(r.status).toBe(0);
  });

  it("records a versioned label, not macos-latest", () => {
    expect(CONFIG.label).toBe("macos-26");
  });

  it.each([
    ["macos-latest", "    runs-on: macos-latest\n"],
    ["a different version", "    runs-on: macos-15\n"],
    ["an unmapped matrix", "    runs-on: ${{ matrix.os }}\n"],
    ["a matrix mapped to the wrong label", "    runs-on: ${{ matrix.os == 'macos-latest' && 'macos-15' || matrix.os }}\n"],
  ])("FAILS on %s", (_label, line) => {
    const wf = write(`wf-${Math.random().toString(36).slice(2)}.yml`, `jobs:\n  a:\n    runs-on: macos-26\n  b:\n${line}`);
    const r = run(["--workflows", "--workflow", wf]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not pinned/);
  });

  it("FAILS when it finds no macOS job at all (reads nothing)", () => {
    const wf = write("ubuntu.yml", "jobs:\n  a:\n    runs-on: ubuntu-latest\n");
    const r = run(["--workflows", "--workflow", wf]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/read nothing/);
  });

  it("FAILS on a config whose label is macos-latest", () => {
    const cfg = write("bad.json", JSON.stringify({ ...CONFIG, label: "macos-latest" }));
    expect(run(["--workflows", "--config", cfg]).status).toBe(1);
  });
});

describe("BACKLOG-3198 check-macos-runner --host", () => {
  it("records exactly the two known images", () => {
    expect(CONFIG.images).toEqual([
      { productVersion: "26.6.2", buildVersion: "25G83" },
      { productVersion: "26.7.2", buildVersion: "25G332" },
    ]);
  });

  it.each([
    ["26.6.2", "25G83"],
    ["26.7.2", "25G332"],
  ])("passes on recorded pair %s / %s", (product, build) => {
    const r = host(product, build);
    expect(r.stdout).toMatch(/OK — macOS/);
    expect(r.status).toBe(0);
  });

  it("FAILS on a mismatched pair (version of one image, build of the other)", () => {
    expect(host("26.7.2", "25G83").status).toBe(1);
    expect(host("26.6.2", "25G332").status).toBe(1);
  });

  it("FAILS on an unrecorded image and lists every recorded pair", () => {
    const r = host("26.8.0", "25H1");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/26\.6\.2 \(25G83\) and 26\.7\.2 \(25G332\)/);
  });

  it("FAILS on the image the incident moved FROM (26.5.2 / 25F84)", () => {
    const r = host("26.5.2", "25F84");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/runner image moved/);
  });

  it("FAILS when only the build differs", () => {
    expect(host(CONFIG.images[1].productVersion, "25G999").status).toBe(1);
  });

  it("--warn reports drift as a workflow warning and exits 0", () => {
    const r = host("26.5.2", "25F84", ["--warn"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^::warning title=macOS runner moved::/m);
  });
});
