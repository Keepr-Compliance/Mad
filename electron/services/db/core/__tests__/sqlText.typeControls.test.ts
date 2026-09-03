/**
 * BACKLOG-3064 — controls 1 and 4. The type-level proofs.
 *
 * "A hand-written string must not reach a database verb" is a claim about the
 * COMPILER. A runtime test can only observe what an already-compiled program does,
 * so it cannot make this assertion at all. The fixtures in
 * `electron/types/__typefixtures__/sql/` are therefore compiled by a real `tsc`,
 * and this suite asserts on its exit code AND its diagnostics.
 *
 * ## Recorded before-evidence — the controls were made to fail first
 *
 * At `int/one-core-many-shells` `2e73ad37f`, with `sqlText.ts` not yet written and
 * ZERO production files changed, all five fixtures that could compile at that
 * commit compiled with **exit 0 and empty output**:
 *
 *     BEFORE  plainStringToDbGet     exit=0  output=[]
 *     BEFORE  plainStringToDbAll     exit=0  output=[]
 *     BEFORE  plainStringToDbRun     exit=0  output=[]
 *     BEFORE  plainStringToDbExec    exit=0  output=[]
 *     BEFORE  interpolatedTemplate   exit=0  output=[]
 *
 * That is the defect. `mustNotCompile-interpolationIntoTag.ts` has **no before-leg
 * and this suite says so**: the `sql` tag did not exist at the base commit, so
 * there was nothing to compile. Its before-evidence is `interpolatedTemplate`,
 * which is the same defect written in the syntax available that day.
 *
 * ## Why one fixture per verb
 *
 * Seven fixtures, seven tsconfigs, seven separate `tsc` runs, seven separate exit
 * codes. Compiling them together would let one fixture's failure mask another's
 * pass — and worse, it would make the MUTATION control uninformative: revert
 * `dbRun` to `string` and a combined fixture still exits 2 because `dbGet` failed,
 * so "exit 2" would answer all four questions at once.
 *
 * BACKLOG-3067 proved the same hazard one level down: its mutation run removed a
 * brand and `tsc` kept exiting 2 anyway, because a different parameter then failed.
 * Only the DIAGNOSTIC TEXT assertion caught it. Every assertion below therefore
 * checks the text, never the exit code alone.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "electron", "types", "__typefixtures__", "sql");
const FIXTURE_GLOB = "electron/types/__typefixtures__/**";

/**
 * Pre-registered. The suite derives the ACTUAL set from the directory and asserts
 * it equals this, so a fixture that is deleted, renamed or quietly added fails here
 * rather than silently reducing what the controls cover.
 */
const EXPECTED_FIXTURES = [
  "mustCompile-legitimateSql",
  "mustNotCompile-interpolatedTemplate",
  "mustNotCompile-interpolationIntoTag",
  "mustNotCompile-plainStringToDbAll",
  "mustNotCompile-plainStringToDbExec",
  "mustNotCompile-plainStringToDbGet",
  "mustNotCompile-plainStringToDbRun",
];

/** The four conduit verbs, and the fixture that is the sole proof for each. */
const VERB_FIXTURES: Array<[verb: string, fixture: string]> = [
  ["dbGet", "mustNotCompile-plainStringToDbGet"],
  ["dbAll", "mustNotCompile-plainStringToDbAll"],
  ["dbRun", "mustNotCompile-plainStringToDbRun"],
  ["dbExec", "mustNotCompile-plainStringToDbExec"],
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

// Each fixture is a full tsc program over the db layer's import graph.
jest.setTimeout(300_000);

describe("BACKLOG-3064 — the fixture set is what the controls claim it is", () => {
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
   * The fixtures are excluded from every root tsconfig ON PURPOSE — six of the
   * seven are supposed to fail to compile, and left in the project they would take
   * `type-check`, `type-check:tests` and `build:electron` red on controls that are
   * working.
   *
   * BACKLOG-3067 established that exclusion as a DIRECTORY GLOB, which is why this
   * item's fixtures live in a subdirectory of the same tree and this commit edits
   * no tsconfig and no eslint config at all. This test is what keeps that true:
   * derived by globbing the repo root, not by naming three files from memory.
   * `tsconfig.test.json` is the one that bites — it redeclares `exclude` in full
   * (BACKLOG-2414) and inherits nothing.
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
    const fixture = ts.readConfigFile(
      path.join(FIXTURE_DIR, "tsconfig.base.json"),
      ts.sys.readFile,
    ).config.compilerOptions;

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

describe("CONTROL 1 — a hand-written string must not reach a database verb", () => {
  /**
   * One case per verb, each its own `tsc` run. The diagnostic must name `SafeSql`:
   * "exit 2" alone is consistent with the fixture being broken for an unrelated
   * reason, which is precisely how BACKLOG-3067's mutation slipped past its exit
   * code.
   */
  it.each(VERB_FIXTURES)("refuses a bare string at %s (TS2345 naming SafeSql)", (verb, fixture) => {
    const run = compileFixture(fixture);

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("error TS2345");
    expect(run.output).toContain(`${fixture}.ts`);
    expect(run.output).toContain(
      "Argument of type 'string' is not assignable to parameter of type 'SafeSql'",
    );
    // The refusal must be BECAUSE of the brand, not because some other string was
    // rejected: the reported reason names the brand carrier itself.
    expect(run.output).toContain("SqlBrand");
    // And the fixture must genuinely be calling the verb it claims to test.
    expect(fs.readFileSync(path.join(FIXTURE_DIR, `${fixture}.ts`), "utf8")).toContain(
      `import { ${verb} } from`,
    );
  });

  /**
   * The BACKLOG-3062 defect shape, transcribed from the repo's own record of the
   * real producer (`message-import-handlers.allTime-2561.test.ts:425`) rather than
   * invented. This is the case the item argues no matcher can see: a template that
   * splices a value is lexically identical to a template that writes a sentence.
   */
  it("refuses a template literal that splices a value into SQL", () => {
    const run = compileFixture("mustNotCompile-interpolatedTemplate");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("error TS2345");
    expect(run.output).toContain(
      "Argument of type 'string' is not assignable to parameter of type 'SafeSql'",
    );
  });

  /**
   * The authoring site — the half a boundary check can never reach. The four
   * fixtures above prove the DOOR is shut; this proves the PRODUCER will not mint a
   * brand around a spliced value, so the natural thing to write is also the correct
   * thing rather than a thing caught later by review.
   *
   * The diagnostic must name `number`, not `string`: that is what distinguishes
   * "the tag rejected a VALUE" from "the tag rejected something".
   */
  it("refuses a VALUE interpolated into the sql tag (TS2345 naming number)", () => {
    const run = compileFixture("mustNotCompile-interpolationIntoTag");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("error TS2345");
    expect(run.output).toContain(
      "Argument of type 'number' is not assignable to parameter of type 'SafeSql'",
    );
  });
});

describe("CONTROL 4 — satisfiability, the must-NOT-fire case", () => {
  /**
   * A brand nothing can satisfy passes every control above and is worthless. A
   * brand that makes ordinary work awkward gets cast away everywhere within a week,
   * and then the repo carries the ceremony with none of the guarantee — which is
   * exactly what happened to `sqlFieldWhitelist.ts` (BACKLOG-2739), a whitelist
   * whose types had silently widened to `string`.
   *
   * This fixture runs under the same compiler settings as the failing ones, which
   * is also what rules out "they fail because the fixture environment is broken".
   */
  it("compiles the legitimate path clean, with zero casts", () => {
    const run = compileFixture("mustCompile-legitimateSql");

    expect(run.output).toBe("");
    expect(run.status).toBe(0);
  });

  /** The fixture must contain no escape hatch, or its exit 0 means nothing. */
  it("contains no cast, assertion or suppression that could be doing the work", () => {
    const source = fs.readFileSync(path.join(FIXTURE_DIR, "mustCompile-legitimateSql.ts"), "utf8");
    // Strip comments first: the file explains itself at length, and prose about
    // casts is not a cast.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/\bas\s+(?:unknown|any|SafeSql)\b/);
    expect(code).not.toContain("unsafeSql");
    expect(code).not.toContain("@ts-ignore");
    expect(code).not.toContain("@ts-expect-error");
    expect(code).not.toMatch(/:\s*any\b/);

    // It must actually exercise all four verbs and the composition path, or "no
    // casts" is a claim about a file that proves nothing.
    // Matched with the type argument allowed: `dbGet<{ id: string }>(` does not
    // contain `dbGet(`, and asserting the latter would fail on correct code.
    for (const verb of ["dbGet", "dbAll", "dbRun", "dbExec"]) {
      expect([verb, new RegExp(`\\b${verb}\\s*(?:<[^>]*>)?\\s*\\(`).test(code)]).toEqual([
        verb,
        true,
      ]);
    }
    expect(code).toMatch(/sql`[^`]*\$\{/);
  });
});
