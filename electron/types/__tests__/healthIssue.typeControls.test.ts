/**
 * BACKLOG-3230 — the type-level controls for the health-check wire contract.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE CANNOT BE ORDINARY TESTS
 * ---------------------------------------------------------------------------
 * The item's verification bar is *"change a field name in the producer and
 * confirm `npm run type-check` FAILS"*. That is a claim about the COMPILER, and
 * a runtime test can only observe what an already-compiled program does. So the
 * fixtures in `../__typefixtures__/healthIssue/` are compiled by a real `tsc`
 * and this suite asserts on its exit code and diagnostics.
 *
 * ---------------------------------------------------------------------------
 * RECORDED BEFORE-EVIDENCE — the controls are informative because they were
 * made to fail first
 * ---------------------------------------------------------------------------
 * At develop `a6fe128aa`, with the renderer's local `SystemIssue` interface
 * still in place, the cast in `mustNotCompile-stringArrayCast` compiled with
 * **exit 0 and ZERO diagnostics**. Every property of that interface was
 * optional, making it a WEAK type and therefore mutually comparable with
 * `string` — so `string[] as SystemIssue[]` was legal. The declared wire type
 * and the real payload could not be compared, which is why they were allowed to
 * disagree for as long as they did.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BAR DOES *NOT* COVER — read before trusting it
 * ---------------------------------------------------------------------------
 * Stated plainly, because an overstated gate is worse than a narrow one: the
 * next person stops checking.
 *
 *  1. `diagnosticHandlers.ts` loads `permissionService` and
 *     `connectionStatusService` through `require(...)` (the test mocks depend on
 *     it), so everything they return arrives as `any`. **Renaming a field inside
 *     those services is not caught by this contract.** Measured: renaming
 *     `errorCode` in `permissionService` produces diagnostics in
 *     `permissionService` itself and in `contactHandlers.ts` — and NONE in
 *     `diagnosticHandlers.ts` or `SystemHealthMonitor.tsx`.
 *  2. `decorateFdaPermissionIssues` and `collapseFdaPermissionIssues` are
 *     declared `: unknown[]` by BACKLOG-3237's design. A literal returned
 *     through `unknown[]` gets no excess-property check, so renames inside those
 *     two helpers are NOT covered. BACKLOG-3233 owns them.
 *  3. `electron/types/ipc/channels.ts` types only the generic
 *     `window.api.invoke` escape hatch, which nothing in `src/` calls. Mutating
 *     its `system:health-check` entry to a contradictory type was measured at
 *     exit 0 on both root gates. It is corrected for honesty and deliberately
 *     has no control.
 *
 * **Covered: the wire itself, and the one connection-row literal built inside
 * `diagnosticHandlers.ts`.** That is a real gate where there was none.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "electron", "types", "__typefixtures__", "healthIssue");
const FIXTURE_GLOB = "electron/types/__typefixtures__/**";

/**
 * Pre-registered. The suite derives the ACTUAL set from the directory and
 * asserts it equals this, so a fixture that is deleted, renamed or quietly added
 * fails here rather than silently reducing what the controls cover.
 */
const EXPECTED_FIXTURES = [
  "mustCompile-legitimateUse",
  "mustNotCompile-producerFieldRename",
  "mustNotCompile-stringArrayCast",
];

interface TscRun {
  status: number;
  output: string;
}

function compileFixture(name: string): TscRun {
  // `process.execPath` + the resolved tsc entry point, not `npx` and not a shell
  // string: this suite runs on the Windows CI leg too.
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("typescript/lib/tsc.js"),
      "-p",
      path.join(FIXTURE_DIR, `tsconfig.${name}.json`),
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// Each fixture is a full tsc program over the connection service's import graph
// (~1.5s local, measured).
jest.setTimeout(180_000);

describe("BACKLOG-3230 — the fixture set is what the controls claim it is", () => {
  it("contains exactly the pre-registered fixtures, each with its own tsconfig", () => {
    const entries = fs.readdirSync(FIXTURE_DIR);

    const fixtures = entries
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""))
      .sort();
    expect(fixtures).toEqual([...EXPECTED_FIXTURES].sort());

    const configs = entries
      .filter((f) => f.startsWith("tsconfig.") && f !== "tsconfig.base.json")
      .map((f) => f.replace(/^tsconfig\./, "").replace(/\.json$/, ""))
      .sort();
    expect(configs).toEqual([...EXPECTED_FIXTURES].sort());
  });

  /**
   * Two of these fixtures are SUPPOSED to fail to compile. Left in the root
   * project they would take `type-check`, `type-check:tests` and
   * `build:electron` red on controls that are working. The glob is derived by
   * reading the configs rather than named from memory.
   */
  it("is excluded from every root tsconfig, discovered by glob, not by memory", () => {
    const configs = fs
      .readdirSync(REPO_ROOT)
      .filter((f) => /^tsconfig(\..+)?\.json$/.test(f))
      .sort();

    expect(configs.length).toBeGreaterThanOrEqual(3);

    const missing = configs.filter((f) => {
      const parsed = ts.readConfigFile(path.join(REPO_ROOT, f), ts.sys.readFile);
      expect(parsed.error).toBeUndefined();
      return !(parsed.config.exclude ?? []).includes(FIXTURE_GLOB);
    });
    expect(missing).toEqual([]);
  });

  /**
   * A fixture compiled under weaker settings than the real code proves nothing
   * about the real code.
   */
  it("compiles the fixtures under the same strictness as the real code", () => {
    const root = ts.readConfigFile(path.join(REPO_ROOT, "tsconfig.json"), ts.sys.readFile).config
      .compilerOptions;
    const fixture = ts.readConfigFile(path.join(FIXTURE_DIR, "tsconfig.base.json"), ts.sys.readFile)
      .config.compilerOptions;

    for (const key of [
      "strict",
      "strictNullChecks",
      "strictFunctionTypes",
      "noImplicitAny",
      "target",
      "module",
      "moduleResolution",
      "esModuleInterop",
    ]) {
      expect([key, fixture[key]]).toEqual([key, root[key]]);
    }
  });
});

describe("CONTROL 1 — the wire cast that hid the disagreement must not compile", () => {
  it("refuses string[] where HealthIssue[] is required (TS2352)", () => {
    const run = compileFixture("mustNotCompile-stringArrayCast");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("TS2352");
    // The specific reason matters: the two types no longer overlap at all, which
    // is exactly what a weak type failed to establish.
    expect(run.output).toContain("sufficiently overlaps");
  });
});

describe("CONTROL 2 — the item's own bar: a renamed producer field must not compile", () => {
  it("refuses an unknown property on the connection row literal (TS2353)", () => {
    const run = compileFixture("mustNotCompile-producerFieldRename");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("TS2353");
    expect(run.output).toContain("'sev' does not exist in type 'HealthConnectionIssue'");
  });
});

describe("CONTROL 3 — the real shapes must still compile", () => {
  /**
   * Without this, controls 1 and 2 prove nothing: a broken fixture environment
   * fails everything. This one shares `tsconfig.base.json` with them, so its
   * pass is what makes their failures attributable to the type.
   */
  it("accepts every row the producer emits and every read the renderer performs", () => {
    const run = compileFixture("mustCompile-legitimateUse");

    expect(run.output).toBe("");
    expect(run.status).toBe(0);
  });
});
