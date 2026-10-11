/**
 * @jest-environment node
 */

/**
 * BACKLOG-3675 — the release gate fails while the offline pass key map is the
 * empty placeholder, and passes once it holds a valid Ed25519 public key.
 */

import { spawnSync } from "child_process";
import { generateKeyPairSync } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.join(__dirname, "../ci/check-offline-pass-keys.mjs");
let dir = "";

const run = (args: string[] = []) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

function fixture(body: string): string {
  const file = path.join(dir, `keys-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(
    file,
    `export const OFFLINE_PASS_PUBLIC_KEYS: Readonly<Record<string, string>> = Object.freeze({\n${body}\n});\n`,
  );
  return file;
}

const spki = (type: "ed25519" | "x25519" = "ed25519") =>
  generateKeyPairSync(type as "ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "keepr-3675-keys-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("BACKLOG-3675 check-offline-pass-keys", () => {
  it("passes on the file in the repo (production key k1)", () => {
    const r = run();
    expect(r.stdout).toMatch(/OK — 1 key\(s\): k1/);
    expect(r.status).toBe(0);
  });

  it("FAILS on an empty map (the placeholder)", () => {
    const r = run(["--file", fixture("")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/empty \(placeholder\)/);
  });

  it("passes with one valid Ed25519 key", () => {
    const r = run(["--file", fixture(`  k1: "${spki()}",`)]);
    expect(r.stdout).toMatch(/OK — 1 key\(s\): k1/);
    expect(r.status).toBe(0);
  });

  it("fails when the only key is commented out", () => {
    expect(run(["--file", fixture(`  // k1: "${spki()}",`)]).status).toBe(1);
  });

  it("fails on a value that is not a public key", () => {
    expect(run(["--file", fixture(`  k1: "bm90IGEga2V5",`)]).status).toBe(1);
  });

  it("fails on a non-Ed25519 key", () => {
    expect(run(["--file", fixture(`  k1: "${spki("x25519")}",`)]).status).toBe(1);
  });

  it("fails when one of two keys is invalid", () => {
    expect(run(["--file", fixture(`  k1: "${spki()}",\n  k2: "AAAA",`)]).status).toBe(1);
  });
});
