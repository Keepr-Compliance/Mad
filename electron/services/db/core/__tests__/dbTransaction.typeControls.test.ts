/**
 * BACKLOG-2960 PR 0b — controls C1, C2 and C2b. The type-level proofs.
 *
 * "An `async` transaction body must not COMPILE" is a claim about the compiler. A
 * runtime test can only observe what an already-compiled program does, so it
 * cannot make this assertion at all. The fixtures in
 * `electron/types/__typefixtures__/dbTransaction/` are therefore compiled by a
 * real `tsc`, and this suite asserts on its exit code AND its diagnostics.
 *
 * ## Recorded before-evidence — the controls were made to fail first
 *
 * At `int/epic9-close` `139913c51`, with `dbTransaction` still typed
 * `(fn: () => T): T` and ZERO production files changed, the two hole fixtures
 * compiled with **exit 0 and no diagnostics**:
 *
 *     BEFORE  mustNotCompile-asyncBody              exit=0
 *     BEFORE  mustNotCompile-promiseReturningBody   exit=0
 *     BEFORE  mustCompile-syncBodies                exit=0   (unchanged by design)
 *     BEFORE  mustNotCompile-inferenceIsPrecise     exit=2   TS2322 (see below)
 *
 * That is the defect: an `async` body commits at its first `await`, and nothing
 * in the toolchain objected. `inferenceIsPrecise` is not a before/after
 * discriminator — the old signature inferred `T` precisely too — it guards the
 * NEW signature against a later widening to `any`/`never`/`unknown`, which would
 * leave the other two controls passing while proving nothing.
 *
 * ## Why one fixture per case
 *
 * Four fixtures, four tsconfigs, four separate `tsc` runs, four separate exit
 * codes. Compiling them together would let one fixture's failure mask another's
 * pass, and would make the mutation control uninformative: weaken the signature
 * and a combined run still exits 2 because `inferenceIsPrecise` failed. BACKLOG-3067
 * proved the same hazard one level down, and only the DIAGNOSTIC TEXT assertion
 * caught it. Every assertion below therefore checks the text, never the exit
 * code alone.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "electron", "types", "__typefixtures__", "dbTransaction");
const FIXTURE_GLOB = "electron/types/__typefixtures__/**";

/**
 * Pre-registered. The suite derives the ACTUAL set from the directory and asserts
 * it equals this, so a fixture that is deleted, renamed or quietly added fails here
 * rather than silently reducing what the controls cover.
 */
const EXPECTED_FIXTURES = [
  "mustCompile-syncBodies",
  "mustNotCompile-asyncBody",
  "mustNotCompile-inferenceIsPrecise",
  "mustNotCompile-promiseReturningBody",
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
    [require.resolve("typescript/lib/tsc.js"), "-p", path.join(FIXTURE_DIR, `tsconfig.${name}.json`)],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

// Each fixture is a full tsc program over dbConnection's import graph (~2s local).
jest.setTimeout(180_000);

describe("BACKLOG-2960 PR 0b — the fixture set is what the controls claim it is", () => {
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
   * The fixtures are excluded from every root tsconfig ON PURPOSE — three of them
   * are supposed to fail to compile, and left in the project they would take
   * `type-check`, `type-check:tests` and `build:electron` red on working controls.
   * The exclusion is the existing BACKLOG-3067 glob; this derives the config set by
   * globbing rather than naming files from memory, because `tsconfig.test.json`
   * redeclares `exclude` in full and inherits nothing.
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
   * about the real code. `tsconfig.base.json` cannot `extends` the root config
   * (the root excludes this very directory), so the options are duplicated — and
   * duplication is drift waiting to happen. This pins the load-bearing ones.
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

  /**
   * The fixtures must import the REAL `dbTransaction`. A fixture that re-declares
   * the signature it is testing proves only that it agrees with itself, and would
   * keep passing after the production signature was weakened.
   */
  it("every fixture imports the production dbTransaction, not a local re-declaration", () => {
    for (const name of EXPECTED_FIXTURES) {
      const source = fs.readFileSync(path.join(FIXTURE_DIR, `${name}.ts`), "utf8");
      expect([name, /import \{ dbTransaction \} from "\.\.\/\.\.\/\.\.\/services\/db\/core\/dbConnection"/.test(source)]).toEqual([name, true]);
      expect([name, /function dbTransaction\b/.test(source)]).toEqual([name, false]);
    }
  });
});

describe("the synchronous bodies the tree actually has must keep compiling", () => {
  /**
   * The signature is only acceptable if it costs the 37 real transaction bodies
   * nothing. `void`, row-or-undefined, number, and an explicit generic argument all
   * compile, and `T` comes back exact — the typed consts in the fixture would not
   * accept `unknown`.
   */
  it("mustCompile-syncBodies compiles with exit 0 and no output", () => {
    const run = compileFixture("mustCompile-syncBodies");
    expect([run.status, run.output]).toEqual([0, ""]);
  });
});

describe("CONTROL C1 — an async transaction body must not compile", () => {
  it("refuses `dbTransaction(async () => { await … })` with TS2345 against '() => never'", () => {
    const run = compileFixture("mustNotCompile-asyncBody");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("error TS2345");
    expect(run.output).toContain("mustNotCompile-asyncBody.ts");
    expect(run.output).toContain(
      "Argument of type '() => Promise<void>' is not assignable to parameter of type '() => never'",
    );
  });
});

describe("CONTROL C2 — a non-async body that returns a promise must not compile", () => {
  /**
   * MEASURED, NOT CITED: 5687984d C2 recorded this case as TS2322. Against the
   * ruled signature a block-bodied arrow is rejected as a whole argument — TS2345,
   * the same code as C1 — with the promise type named in the message. The text
   * assertion is what carries the proof; the code is recorded as observed.
   */
  it("refuses `dbTransaction(() => { return readRow(); })` with TS2345 against '() => never'", () => {
    const run = compileFixture("mustNotCompile-promiseReturningBody");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("error TS2345");
    expect(run.output).toContain("mustNotCompile-promiseReturningBody.ts");
    expect(run.output).toContain(
      "Argument of type '() => Promise<{ id: string; } | undefined>' is not assignable to parameter of type '() => never'",
    );
  });
});

describe("CONTROL C2b — the control on the control: T is inferred exactly", () => {
  /**
   * A constraint that accepted everything by inferring `any` or `never` would pass
   * C1's mustCompile leg AND let this line through. `number` must not be assignable
   * to `string`, so the inference is precise and the other two controls mean what
   * they say.
   */
  it("refuses `const s: string = dbTransaction(() => 1)` with TS2322 number→string", () => {
    const run = compileFixture("mustNotCompile-inferenceIsPrecise");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("error TS2322");
    expect(run.output).toContain("mustNotCompile-inferenceIsPrecise.ts");
    expect(run.output).toContain("Type 'number' is not assignable to type 'string'");
  });
});
