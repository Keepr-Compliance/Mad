/**
 * BACKLOG-3456: registerSyncHandlers(userId?) takes an optional string. After the
 * window parameter was dropped, a stale call that still passes a window (for example
 * `registerSyncHandlers(win as never)`) compiles and runs. This scan fails on any
 * call in main.ts or a test file whose argument is not absent or a string literal.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SELF = "electron/handlers/__tests__/registerSyncHandlersArity-3456.test.ts";

function scannedFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => f === "electron/main.ts" || /(^|\/)(__tests__|tests)\//.test(f) || /\.test\.tsx?$/.test(f))
    .filter((f) => f !== SELF);
}

function collectCalls(): { file: string; arg: string }[] {
  const calls: { file: string; arg: string }[] = [];
  for (const file of scannedFiles()) {
    const abs = path.join(REPO_ROOT, file);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, "utf8");
    for (const m of text.matchAll(/\bregisterSyncHandlers\(([^)]*)\)/g)) {
      calls.push({ file, arg: m[1].trim() });
    }
  }
  return calls;
}

describe("registerSyncHandlers call arity (BACKLOG-3456)", () => {
  const calls = collectCalls();

  it("finds the known calls (positive control)", () => {
    expect(calls.length).toBeGreaterThanOrEqual(12);
  });

  it("every call passes no argument or a string literal", () => {
    const bad = calls.filter((c) => !(c.arg === "" || /^"[^"\n]*"$/.test(c.arg) || /^'[^'\n]*'$/.test(c.arg)));
    expect(bad).toEqual([]);
  });
});
