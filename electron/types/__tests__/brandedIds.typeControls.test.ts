/**
 * BACKLOG-3067 — controls 1, 2 and 3. The type-level proofs.
 *
 * These assertions cannot be written as ordinary tests. "Passing an email id where
 * a communication id belongs must not COMPILE" is a claim about the compiler, and
 * a runtime test can only observe what a compiled program does. So the fixtures in
 * `../__typefixtures__/ids/` are compiled by a real `tsc`, and this suite asserts
 * on its exit code and its diagnostics.
 *
 * Recorded before-evidence (the control is only informative because it was made to
 * fail first): at develop `b6333050a`, with the brands not yet written and zero
 * production files changed, `mustNotCompile-defect2829.ts` compiled with **exit 0**.
 * That is BACKLOG-2829 being invisible to the entire toolchain. The same file now
 * exits 2 with TS2345.
 *
 * Three fixtures, three separate `tsc` runs, three separate exit codes — compiling
 * them together would let one fixture's failure mask another's pass. All three share
 * `tsconfig.base.json`, which is what makes the passing fixture meaningful: it proves
 * the two failures are caused by the brand and not by a broken fixture environment.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "electron", "types", "__typefixtures__", "ids");
const FIXTURE_GLOB = "electron/types/__typefixtures__/**";

/**
 * Pre-registered. The suite derives the ACTUAL set from the directory and asserts
 * it equals this — so a fixture that is deleted, renamed or quietly added fails
 * here rather than silently reducing what the controls cover.
 */
const EXPECTED_FIXTURES = [
  "mustCompile-legitimateUse",
  "mustNotCompile-defect2829",
  "mustNotCompile-emailIdForCommunicationId",
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

// Each fixture is a full tsc program over the db service's import graph (~2s local).
jest.setTimeout(180_000);

describe("BACKLOG-3067 — the fixture set is what the controls claim it is", () => {
  it("contains exactly the pre-registered fixtures, each with its own tsconfig", () => {
    const entries = fs.readdirSync(FIXTURE_DIR);

    const fixtures = entries
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".json"))
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
   * The fixtures are excluded from every root tsconfig ON PURPOSE — two of them are
   * supposed to fail to compile, and left in the project they would take
   * `type-check`, `type-check:tests` and `build:electron` red on working controls.
   *
   * That exclusion is also the hazard: a fixture excluded from a config it SHOULD
   * be in is invisible, so this derives the config set by globbing rather than
   * naming three files from memory. `tsconfig.test.json` is the one that bites —
   * it redeclares `exclude` in full on purpose (BACKLOG-2414) and inherits nothing.
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
   * (the root now excludes this very directory), so the options are duplicated —
   * and duplication is drift waiting to happen. This pins the load-bearing ones.
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

describe("CONTROL 1 + 2 — the BACKLOG-2829 defect must not compile", () => {
  /**
   * The defect exactly as it is written in production today: an id from the
   * `emails` table passed into the `communicationId` parameter. Before the brands
   * this compiled clean, which is why the UPDATE has always matched zero rows and
   * reported success.
   */
  it("refuses a bare string where a CommunicationId is required (TS2345)", () => {
    const run = compileFixture("mustNotCompile-defect2829");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("error TS2345");
    expect(run.output).toContain("mustNotCompile-defect2829.ts");
    expect(run.output).toContain(
      "Argument of type 'string' is not assignable to parameter of type 'CommunicationId'",
    );
  });

  /**
   * The stronger form. Control 1's diagnostic can only say "string" — it cannot
   * name the kind of id that was actually passed, so on its own it is also
   * consistent with "some unrelated string got rejected". This one makes the
   * compiler name BOTH types, which is the assertion that the two brands are
   * genuinely distinct rather than merely non-string.
   */
  it("names both id kinds when an EmailId is passed for a CommunicationId", () => {
    const run = compileFixture("mustNotCompile-emailIdForCommunicationId");

    expect(run.status).not.toBe(0);
    expect(run.output).toContain("error TS2345");
    expect(run.output).toContain(
      "Argument of type 'EmailId' is not assignable to parameter of type 'CommunicationId'",
    );
    // The brands are discriminated by their tag, not merely by being different
    // objects — so the tag mismatch has to be the stated reason.
    expect(run.output).toContain("Types of property '__brand' are incompatible");
  });
});

describe("CONTROL 3 — the must-NOT-fire case", () => {
  /**
   * Satisfiability plus erasure, in one program: a row read out of the database
   * flows into the write with no cast, and a branded id is still usable as a
   * string in a template literal, `JSON.stringify`, a `Map` key, an object key, a
   * plain `string` parameter, and every string method.
   *
   * A brand nothing can satisfy passes controls 1 and 2 and is worthless. A brand
   * that breaks ordinary string use gets cast away everywhere within a week, and
   * then the repo carries the ceremony with none of the guarantee. This fixture is
   * why the item is worth shipping, and it runs under the same compiler settings
   * as the two failing ones — which is what rules out "they fail because the
   * fixture environment is broken".
   */
  it("compiles the legitimate path clean, with zero casts", () => {
    const run = compileFixture("mustCompile-legitimateUse");

    expect(run.output).toBe("");
    expect(run.status).toBe(0);
  });

  /** The fixture must contain no escape hatch, or its exit 0 means nothing. */
  it("contains no cast, assertion or suppression that could be doing the work", () => {
    const source = fs.readFileSync(
      path.join(FIXTURE_DIR, "mustCompile-legitimateUse.ts"),
      "utf8",
    );
    // Strip comments before looking for escapes: the file explains itself at length,
    // and prose about casts is not a cast.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/\bas\s+(?:unknown|any|CommunicationId|EmailId|TransactionId)\b/);
    expect(code).not.toMatch(/\bas[A-Z]\w*Id\s*\(/);
    expect(code).not.toContain("@ts-ignore");
    expect(code).not.toContain("@ts-expect-error");
    expect(code).not.toMatch(/:\s*any\b/);
    expect(code).not.toContain("!.");
  });
});
