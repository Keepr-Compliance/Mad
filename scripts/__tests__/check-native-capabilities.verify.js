#!/usr/bin/env node
/**
 * VERIFICATION HARNESS for scripts/ci/check-native-capabilities.mjs — BACKLOG-2962
 * ============================================================================
 * A guard that has never been seen red proves nothing. This runs in CI as the
 * "Verify the guard itself" step and plants a violation of every shape the gate
 * claims to catch, plus every shape it claims to IGNORE.
 *
 * The ignore cases are not padding. This item's scope was mis-measured three
 * times (86 -> 17/10 -> 15/6; the truth is 14 call expressions in 5 files) and
 * every error had one cause: a line matcher counting a mention as a call. C8 and
 * C9 are that exact defect, planted deliberately, and a gate that goes red on
 * them has reproduced the bug it was written to end.
 *
 *   C1   clean fixture tree                                  -> GREEN
 *   C2   import { safeStorage } from "electron"              -> RED   (R1)
 *   C3   import { safeStorage as ss } from "electron"        -> RED   (R1, aliased)
 *   C4   import * as electron + electron.safeStorage         -> RED   (R1, namespace)
 *   C5   import electron from "electron" + .safeStorage      -> RED   (R1, default)
 *   C6   const { safeStorage } = require("electron")         -> RED   (R1, require)
 *   C7   require("electron").safeStorage inline              -> RED   (R1, inline require)
 *   C8   `safeStorage.encryptString()` in a JSDoc comment    -> GREEN (the mis-measurement bug)
 *   C9   the string literal "safeStorage.encryptString()"    -> GREEN
 *   C10  import type { SafeStorage } from "electron"         -> GREEN (erased; calls nothing)
 *   C11  import { safeStorage } from "./localShim"           -> GREEN (not the electron module)
 *   C12  the same violation inside the allowed home dir      -> GREEN
 *   C13  a violation in an UNTRACKED file                    -> RED   (BACKLOG-3049)
 *   C14  a PORTABLE module importing { app } from "electron" -> RED   (R2, no safeStorage at all)
 *   C15  a PORTABLE module importing only a TYPE             -> GREEN (R2 ignores type-only)
 *   C16  a PORTABLE module missing from the tree             -> RED   (stale list)
 *   C17  namespace import, .safeStorage never accessed       -> GREEN (a binding is not a reach)
 *   C18  const { safeStorage } = await import("electron")     -> RED   (R1, dynamic import)
 *   C19  (await import("electron")).safeStorage inline        -> RED   (R1, dynamic, unbound)
 *   C20  PORTABLE module destructuring await import()         -> RED   (R2)
 *   C21  PORTABLE module, bare dynamic import, no binding     -> RED   (R2)
 *   C22  await import of a LOCAL module named similarly       -> GREEN
 *   CENSUS  the gate reports 2 of 2 portable modules checked -> the counter that
 *           caught a real defect in the gate during implementation, pinned so it
 *           cannot silently undercount again
 */

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const GATE = path.join(REPO_ROOT, "scripts", "ci", "check-native-capabilities.mjs");

const results = [];
const record = (id, name, ok, detail) => results.push({ id, name, ok, detail });

/** A minimal tree that the gate considers clean. */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nativecap-verify-"));
  const write = (rel, body) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  // The two declared-portable modules must exist, and must be clean.
  write("electron/services/keychainGate.ts", "export const gate = 1;\n");
  write("electron/services/tokenEncryptionService.ts", "export const svc = 1;\n");
  // The allowed home for safeStorage.
  write(
    "electron/capabilities/electron/electronSecretStore.ts",
    'import { safeStorage } from "electron";\nexport const isOk = () => safeStorage.isEncryptionAvailable();\n',
  );
  write("electron/services/ordinary.ts", "export const x = 1;\n");

  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return { dir, write };
}

function runGate(dir) {
  const r = spawnSync(process.execPath, [GATE, "--root", dir, "--json"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* leave null; the caller reports the raw output */
  }
  return { code: r.status, json, out: r.stdout, err: r.stderr };
}

/**
 * Plant `body` at `rel`, run the gate, expect red/green.
 * `track` false leaves the file untracked (C13).
 */
function control(id, name, rel, body, expectRed, { track = true, rule = null } = {}) {
  const { dir, write } = makeFixture();
  try {
    write(rel, body);
    if (track) execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = runGate(dir);
    const red = r.code !== 0;
    const ruleOk =
      rule === null || (r.json && r.json.violations.some((v) => v.rule === rule));
    const ok = red === expectRed && (!expectRed || ruleOk);
    record(
      id,
      name,
      ok,
      `exit=${r.code} violations=${r.json ? r.json.violations.length : "?"}` +
        (r.json && r.json.violations.length
          ? ` [${r.json.violations.map((v) => `${v.rule}:${v.file}`).join(", ")}]`
          : "") +
        (ok ? "" : `\n      RAW: ${r.out}${r.err}`),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- C1: a clean tree is green, and the census is right ---------------------
{
  const { dir } = makeFixture();
  try {
    const r = runGate(dir);
    record("C1", "clean fixture tree -> GREEN", r.code === 0, `exit=${r.code}`);
    record(
      "CENSUS",
      "gate reports 2 of 2 portable modules checked",
      r.json && r.json.portableChecked === 2,
      `portableChecked=${r.json ? r.json.portableChecked : "?"} (a file whose only ` +
        'mention of the platform is the capitalised word "Electron" must still be checked)',
    );
    record(
      "CENSUS2",
      "gate reports exactly 1 file reaching safeStorage",
      r.json && r.json.safeStorageFiles === 1,
      `safeStorageFiles=${r.json ? r.json.safeStorageFiles : "?"}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const V = "electron/services/violator.ts";

control("C2", 'import { safeStorage } from "electron" -> RED', V,
  'import { safeStorage } from "electron";\nexport const f = () => safeStorage.isEncryptionAvailable();\n',
  true, { rule: "R1" });

control("C3", "aliased named import -> RED", V,
  'import { safeStorage as ss } from "electron";\nexport const f = () => ss.isEncryptionAvailable();\n',
  true, { rule: "R1" });

control("C4", "namespace import + .safeStorage -> RED", V,
  'import * as electron from "electron";\nexport const f = () => electron.safeStorage.isEncryptionAvailable();\n',
  true, { rule: "R1" });

control("C5", "default import + .safeStorage -> RED", V,
  'import electron from "electron";\nexport const f = () => electron.safeStorage.isEncryptionAvailable();\n',
  true, { rule: "R1" });

control("C6", 'const { safeStorage } = require("electron") -> RED', V,
  'const { safeStorage } = require("electron");\nexport const f = () => safeStorage.isEncryptionAvailable();\n',
  true, { rule: "R1" });

control("C7", 'require("electron").safeStorage inline -> RED', V,
  'export const f = () => require("electron").safeStorage.isEncryptionAvailable();\n',
  true, { rule: "R1" });

control("C8", "safeStorage named in a JSDoc COMMENT -> GREEN", V,
  '/**\n * The key store is sealed with `safeStorage.encryptString()`, so its presence\n * proves an OS keychain was reachable at least once.\n */\nexport const f = () => 1;\n',
  false);

control("C9", "safeStorage inside a STRING LITERAL -> GREEN", V,
  'export const label = "safeStorage.encryptString() is unavailable";\nexport const f = () => label;\n',
  false);

control("C10", "import type from electron -> GREEN", V,
  'import type { SafeStorage } from "electron";\nexport type S = SafeStorage;\n',
  false);

control("C11", "safeStorage imported from a LOCAL module -> GREEN", V,
  'import { safeStorage } from "./localShim";\nexport const f = () => safeStorage.isEncryptionAvailable();\n',
  false);

control("C12", "the same import inside the allowed home -> GREEN",
  "electron/capabilities/electron/another.ts",
  'import { safeStorage } from "electron";\nexport const f = () => safeStorage.isEncryptionAvailable();\n',
  false);

control("C13", "violation in an UNTRACKED file -> RED (BACKLOG-3049)", V,
  'import { safeStorage } from "electron";\nexport const f = () => safeStorage.isEncryptionAvailable();\n',
  true, { track: false, rule: "R1" });

control("C14", 'PORTABLE module importing { app } (no safeStorage) -> RED',
  "electron/services/keychainGate.ts",
  'import { app } from "electron";\nexport const gate = () => app.getPath("userData");\n',
  true, { rule: "R2" });

control("C15", "PORTABLE module importing only a TYPE -> GREEN",
  "electron/services/keychainGate.ts",
  'import type { App } from "electron";\nexport type A = App;\nexport const gate = 1;\n',
  false);

control("C18", 'const { safeStorage } = await import("electron") -> RED', V,
  'export async function f() {\n  const { safeStorage } = await import("electron");\n  return safeStorage.isEncryptionAvailable();\n}\n',
  true, { rule: "R1" });

control("C19", '(await import("electron")).safeStorage inline -> RED', V,
  'export async function f() {\n  return (await import("electron")).safeStorage.isEncryptionAvailable();\n}\n',
  true, { rule: "R1" });

control("C20", 'PORTABLE module using await import("electron") -> RED',
  "electron/services/keychainGate.ts",
  'export async function gate() {\n  const { app } = await import("electron");\n  return app.getPath("userData");\n}\n',
  true, { rule: "R2" });

control("C21", 'PORTABLE module with a bare dynamic import, no binding -> RED',
  "electron/services/keychainGate.ts",
  'export async function gate() {\n  return (await import("electron")).app.getPath("userData");\n}\n',
  true, { rule: "R2" });

control("C22", 'await import of a DIFFERENT module named similarly -> GREEN', V,
  'export async function f() {\n  const { safeStorage } = await import("./electron-shim");\n  return safeStorage.isEncryptionAvailable();\n}\n',
  false);

control("C17", "namespace import whose .safeStorage is never accessed -> GREEN", V,
  'import * as electron from "electron";\nexport const f = () => electron.app.getPath("userData");\n',
  false);

// --- C16: a declared-portable module missing from the tree ------------------
{
  const { dir } = makeFixture();
  try {
    fs.rmSync(path.join(dir, "electron/services/tokenEncryptionService.ts"));
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = runGate(dir);
    const ok =
      r.code !== 0 &&
      r.json &&
      r.json.violations.some(
        (v) => v.rule === "R2" && v.file.endsWith("tokenEncryptionService.ts"),
      );
    record("C16", "PORTABLE module missing from the tree -> RED (stale list)", ok, `exit=${r.code}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- report -----------------------------------------------------------------
let failed = 0;
console.log("Native capability gate — verification harness (BACKLOG-2962)");
console.log("");
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(7)} ${r.name}`);
  console.log(`          ${r.detail}`);
}
console.log("");
console.log(`  ${results.length - failed}/${results.length} controls passed`);
process.exit(failed ? 1 : 0);
