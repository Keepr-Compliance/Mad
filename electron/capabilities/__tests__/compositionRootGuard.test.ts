/**
 * THE COMPOSITION-ROOT GUARD, static half (BACKLOG-2962).
 *
 * THE DEFECT THIS EXISTS FOR, reproduced on this branch before it was written:
 * deleting `electron/main.ts:12` — `import "./bootstrap/installNativeCapabilities";`
 * — left 41 affected suites (815 tests) identically green,
 * `tsc -p tsconfig.electron.json` at exit 0 and `check:native-capabilities` at
 * exit 0. Nothing in the repository could observe it, and the app would have
 * launched and never shown a window.
 *
 * `guards the real tree` below is the test that mutation now reds.
 *
 * The planted cases are not padding. Half of them assert the guard stays
 * GREEN — on a different install order, a different-but-valid import path, a
 * namespace import, an alias, a `require()`. A guard that only ever fires on
 * the one mutation it was written against is a name-matcher, and this repo has
 * shipped seven of those.
 *
 * WHAT THIS GUARD FALSELY REJECTS, AND WHAT IT LETS THROUGH, is stated in full
 * in `tests/helpers/compositionRootStatic.ts`'s header — read it there rather
 * than inferring coverage from the case list below. In short, per SR's
 * five-refactor measurement on PR #2515: it FALSELY REJECTS cross-module
 * indirection (a barrel re-export, or either call moved into a sibling
 * module); it ACCEPTS a same-file wrapper (an earlier version of this comment
 * wrongly listed "wrapper functions" as uncovered); and it LETS THROUGH a call
 * that exists but never runs, a dynamic import, the default-import form, any
 * call-shaped entry import, install order, and anything a bundler would catch.
 *
 * RULE E2 was added after #2515 merged. SR ran the same mutation one line up —
 * delete `electron/main.ts:6`, `import "./bootstrap/installAppDataPaths";` —
 * and nothing went red. Re-measured at `b2cc5cbf7`: 10 affected suites / 160
 * tests identically green, `tsc` exit 0. `guards the real tree: main.ts imports
 * the app-data path override, and it is the FIRST statement` is the test that
 * mutation now reds, and it is the only case here that reads the real
 * `main.ts` for E2. Its position rule is stricter than E1's deliberately: this
 * import's contract, stated in prose at `main.ts:1-5`, is that it stays first.
 * E2 is STATIC ONLY — `installAppDataPaths` gets no runtime assertion, for the
 * measured reasons on `REQUIRED_ENTRY_IMPORTS` in `../nativeCapabilities`.
 */

import * as fs from "fs";
import * as path from "path";

import {
  checkCompositionRoot,
  resolveSpecifier,
  type Finding,
  type RequiredCall,
  type RequiredEntryImport,
} from "../../../tests/helpers/compositionRootStatic";
import {
  COMPOSITION_ROOT,
  NATIVE_CAPABILITIES,
  REQUIRED_COMPOSITION_ROOT_CALLS,
  REQUIRED_ENTRY_IMPORTS,
  SHELL_ENTRY,
} from "../nativeCapabilities";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Read a repo-relative POSIX path off disk. */
function readRepo(relPosix: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...relPosix.split("/")), "utf8");
}

/**
 * Every call the real composition root must make: one per registered
 * capability, plus the runtime self-check itself.
 */
const REQUIRED: RequiredCall[] = [
  ...NATIVE_CAPABILITIES.map((c) => ({
    name: c.name,
    providerModule: c.providerModule,
    installFunction: c.installFunction,
  })),
  ...REQUIRED_COMPOSITION_ROOT_CALLS,
];

/**
 * `secretStore` + the runtime self-check — the pair the HAND-WRITTEN composition
 * roots further down install.
 *
 * Those cases are about the guard's MATCHING SEMANTICS (a namespace import, an
 * alias, a `require()` destructure, a same-named local function, a comment), not
 * about registry completeness. Pinning them to one capability is what lets
 * BACKLOG-2962's seams PR add three more entries without rewriting nine
 * fixtures — and, more importantly, without any of them quietly becoming a test
 * of "did I remember to paste the new install line into this fixture too".
 *
 * Registry completeness against the REAL composition root is asserted by the
 * real-tree case at the top of this file, which uses the full {@link REQUIRED},
 * and by the per-capability deletion case below.
 */
const SECRET_STORE_ONLY: RequiredCall[] = [
  ...NATIVE_CAPABILITIES.filter((c) => c.name === "secretStore").map((c) => ({
    name: c.name,
    providerModule: c.providerModule,
    installFunction: c.installFunction,
  })),
  ...REQUIRED_COMPOSITION_ROOT_CALLS,
];

const REAL_ENTRY_SOURCE = readRepo(SHELL_ENTRY);
const REAL_ROOT_SOURCE = readRepo(`${COMPOSITION_ROOT}.ts`);

/**
 * A minimal entry module that satisfies E1.
 *
 * Every case below that is about C1 uses THIS rather than the real `main.ts`,
 * so each case proves one rule and nothing else. That is deliberate: with the
 * real entry source shared everywhere, deleting `main.ts:12` reddened fourteen
 * tests instead of one, and a fourteen-test failure says less about what broke
 * than a single precisely-named one does. `guards the real tree` is the only
 * case that reads the real `main.ts`, and it is the one control 2 mutates.
 */
const VALID_ENTRY = `import "./bootstrap/installNativeCapabilities";\n`;

/**
 * An entry that satisfies E1 AND E2, for cases about neither.
 *
 * Both lines are transcribed byte-for-byte from the real `electron/main.ts`
 * (statements 1 and 2 — lines 6 and 12 at `b2cc5cbf7`) in their real order, so
 * a case that mutates one of them is mutating the shipped text rather than a
 * paraphrase of it.
 */
const VALID_ENTRY_WITH_BOOTSTRAP = [
  `import "./bootstrap/installAppDataPaths";`,
  `import "./bootstrap/installNativeCapabilities";`,
  ``,
].join("\n");

/** The registry's entry imports: today, the app-data override alone. */
const APP_DATA_IMPORT: RequiredEntryImport[] = [...REQUIRED_ENTRY_IMPORTS];

/** Run the guard over supplied sources. */
function check(over: {
  entrySource?: string;
  compositionRootSource?: string;
  requiredCalls?: RequiredCall[];
  /**
   * Defaults to NONE, not to the registry. Every case written before E2 existed
   * therefore gets byte-identical findings to the ones it got then, and each E2
   * case below opts in explicitly — so an E2 regression cannot hide inside a
   * case that is about something else.
   */
  requiredEntryImports?: RequiredEntryImport[];
}): Finding[] {
  return checkCompositionRoot({
    entryFile: SHELL_ENTRY,
    entrySource: over.entrySource ?? VALID_ENTRY,
    compositionRoot: COMPOSITION_ROOT,
    compositionRootSource: over.compositionRootSource ?? REAL_ROOT_SOURCE,
    requiredCalls: over.requiredCalls ?? REQUIRED,
    requiredEntryImports: over.requiredEntryImports ?? [],
  });
}

const subjects = (findings: Finding[]): string[] => findings.map((f) => f.subject);
const rules = (findings: Finding[]): string[] => findings.map((f) => f.rule);

// ===========================================================================
// THE REAL TREE — this is what control 2 mutates
// ===========================================================================

describe("composition-root guard: the real tree (BACKLOG-2962)", () => {
  it("guards the real tree: main.ts imports the composition root and it installs every registered capability", () => {
    const findings = check({ entrySource: REAL_ENTRY_SOURCE });
    // Print the detail, not just a count: a bare `toHaveLength(0)` failure tells
    // the next engineer nothing about which rule fired.
    expect(findings.map((f) => `${f.rule} ${f.subject}: ${f.detail}`)).toEqual([]);
  });

  it("the registry is not empty, so the assertion above cannot pass vacuously", () => {
    // A guard over an empty required-call list passes trivially. If a future
    // refactor empties NATIVE_CAPABILITIES, every C1 case in this file becomes
    // a no-op and the suite would still be green. This is that trip-wire.
    expect(NATIVE_CAPABILITIES.length).toBeGreaterThan(0);
    expect(REQUIRED.map((r) => r.name)).toEqual([
      "secretStore",
      "logger",
      "errorReporter",
      "appPaths",
      "windows",
      "dialog",
      "appLifecycle",
      "the runtime self-check",
    ]);
  });

  it("names the capabilities it is actually checking", () => {
    // Enumerated, not counted — a count cannot tell a renamed capability from a
    // deleted one. BACKLOG-2962's seams PR adds to this list; the list is
    // updated here rather than loosened to a length check, because the whole
    // value of the case is that a silently DROPPED capability reds it.
    expect(NATIVE_CAPABILITIES.map((c) => c.name)).toEqual([
      "secretStore",
      "logger",
      "errorReporter",
      "appPaths",
      "windows",
      "dialog",
      "appLifecycle",
    ]);
    expect(NATIVE_CAPABILITIES.map((c) => c.installFunction)).toEqual([
      "installSecretStore",
      "installLogger",
      "installErrorReporter",
      "installAppPaths",
      "installWindows",
      "installDialog",
      "installAppLifecycle",
    ]);
    expect(NATIVE_CAPABILITIES.map((c) => c.providerModule)).toEqual([
      "electron/capabilities/secretStoreProvider",
      "electron/capabilities/loggerProvider",
      "electron/capabilities/errorReporterProvider",
      "electron/capabilities/appPathsProvider",
      "electron/capabilities/windowsProvider",
      "electron/capabilities/dialogProvider",
      "electron/capabilities/appLifecycleProvider",
    ]);
  });

  it("guards the real tree: main.ts imports the app-data path override, and it is the FIRST statement", () => {
    // THIS is the test that reds when `electron/main.ts:6` is deleted or moved.
    // Before it existed that mutation was invisible: 10 affected suites / 160
    // tests green and `tsc` exit 0 at `b2cc5cbf7`.
    //
    // It reads E2 findings ONLY — `requiredCalls: []` silences C1, and the
    // filter drops E1 — so that one mutation reds one test. Sharing this case
    // with E1 would mean deleting `main.ts:12` reds two tests, and two failures
    // say less about what broke than one precisely-named failure does. E1 and
    // C1 against the real tree are the case above; neither rule is unwatched.
    const findings = check({
      entrySource: REAL_ENTRY_SOURCE,
      requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
    });
    expect(
      findings.filter((f) => f.rule === "E2").map((f) => `${f.subject}: ${f.detail}`),
    ).toEqual([]);
  });

  it("the entry-import list is not empty, so the assertion above cannot pass vacuously", () => {
    // The filter in the case above hides E1 and C1. If REQUIRED_ENTRY_IMPORTS
    // were ever emptied, that case would assert nothing at all and stay green.
    // Enumerated, not counted: a count cannot tell a renamed entry from a
    // deleted one.
    expect(REQUIRED_ENTRY_IMPORTS.map((e) => e.name)).toEqual(["the app-data path override"]);
    expect(REQUIRED_ENTRY_IMPORTS.map((e) => e.module)).toEqual([
      "electron/bootstrap/installAppDataPaths",
    ]);
    expect(REQUIRED_ENTRY_IMPORTS.map((e) => e.mustBeFirstStatement)).toEqual([true]);
  });
});

// ===========================================================================
// MUST FIRE
// ===========================================================================

describe("composition-root guard: must fire", () => {
  it("E1 — the entry module does not import the composition root at all", () => {
    const stripped = REAL_ENTRY_SOURCE.split("\n")
      .filter((l) => !l.includes(`bootstrap/installNativeCapabilities`))
      .join("\n");
    const findings = check({ entrySource: stripped });

    expect(rules(findings)).toContain("E1");
    expect(findings[0].detail).toContain(COMPOSITION_ROOT);
  });

  it("E1 — a dynamic import() is not recognised, at any position (a conservative false positive, documented)", () => {
    const findings = check({
      entrySource: [
        `function lazyBoot() {`,
        `  import("./bootstrap/installNativeCapabilities");`,
        `}`,
        `lazyBoot();`,
      ].join("\n"),
    });
    expect(rules(findings)).toContain("E1");
  });

  it("E1 — a same-basename module in another directory does not satisfy it", () => {
    // `electron/installNativeCapabilities` is NOT `electron/bootstrap/installNativeCapabilities`.
    // A basename or `endsWith` matcher would wave this through.
    const findings = check({ entrySource: `import "./installNativeCapabilities";\n` });
    expect(rules(findings)).toContain("E1");
  });

  it("E2 — the entry module does not import the app-data override at all, and secretStore is NOT accused", () => {
    // `grep -c 'bootstrap/installAppDataPaths' electron/main.ts` is 1 at
    // `b2cc5cbf7`, so this filter removes exactly the one line. Line 27's
    // `./bootstrap/appDataPaths` — no `install` prefix — does not contain the
    // substring and survives, which is what keeps the fixture a one-line
    // deletion rather than a rewrite.
    const stripped = REAL_ENTRY_SOURCE.split("\n")
      .filter((l) => !l.includes(`bootstrap/installAppDataPaths`))
      .join("\n");
    const findings = check({
      entrySource: stripped,
      requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
    });

    expect(rules(findings)).toEqual(["E2"]);
    expect(subjects(findings)).toEqual(["the app-data path override"]);
    expect(findings[0].detail).toContain("electron/bootstrap/installAppDataPaths");
    // A guard that blames the wrong subject sends the next engineer to the
    // wrong file. secretStore is installed and correct here.
    expect(findings[0].detail).not.toContain("secretStore");
  });

  it("E2 — the override is imported but NOT first, and the failure says what displaced it", () => {
    const findings = check({
      entrySource: [
        `import "./bootstrap/installNativeCapabilities";`,
        `import "./bootstrap/installAppDataPaths";`,
        ``,
      ].join("\n"),
      requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
    });

    expect(rules(findings)).toEqual(["E2"]);
    expect(findings[0].detail).toContain("statement 2 rather than the first");
    expect(findings[0].detail).toContain(`import "./bootstrap/installNativeCapabilities";`);
  });

  it("E2 — a same-basename module in another directory does not satisfy it", () => {
    // `electron/installAppDataPaths` is NOT `electron/bootstrap/installAppDataPaths`.
    const findings = check({
      entrySource: [
        `import "./installAppDataPaths";`,
        `import "./bootstrap/installNativeCapabilities";`,
        ``,
      ].join("\n"),
      requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
    });
    expect(rules(findings)).toEqual(["E2"]);
  });

  it("E2 — a dynamic import() is not recognised (a conservative false positive, documented)", () => {
    const findings = check({
      entrySource: [
        `import "./bootstrap/installNativeCapabilities";`,
        `void import("./bootstrap/installAppDataPaths");`,
        ``,
      ].join("\n"),
      requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
    });
    expect(rules(findings)).toEqual(["E2"]);
  });

  it("E2 — a re-export chain through a barrel is rejected (the other known false reject)", () => {
    // The header lists this beside the type-only case. Pinned rather than
    // traced: on this item SR measured a shipped "traced, not tested" claim
    // false, and an unpinned claim in a file whose next paragraph opens
    // "Measured by SR's review" is the shape that goes stale first.
    //
    // `./bootstrap` resolves to `electron/bootstrap`, which is not
    // `electron/bootstrap/installAppDataPaths`, so E2 reports it MISSING even
    // if that barrel imports the override. Same one-hop resolution limit C1
    // has: this rule reads one file and does not descend into another.
    const findings = check({
      entrySource: [
        `import "./bootstrap";`,
        `import "./bootstrap/installNativeCapabilities";`,
        ``,
      ].join("\n"),
      requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
    });
    expect(rules(findings)).toEqual(["E2"]);
    expect(findings[0].detail).toContain("electron/bootstrap/installAppDataPaths");
  });

  it("E2 — a TYPE-ONLY import above it is rejected, although it is erased (a known false reject)", () => {
    // Pinned deliberately, so the next engineer meets this as DOCUMENTED
    // behaviour rather than as a surprise red on correct code. "First" is
    // `statements[0]`, literally; teaching this file which statement kinds
    // survive emit would be a second, drifting copy of the compiler's rule.
    const findings = check({
      entrySource: [
        `import type { BrowserWindow } from "electron";`,
        `import "./bootstrap/installAppDataPaths";`,
        `import "./bootstrap/installNativeCapabilities";`,
        ``,
      ].join("\n"),
      requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
    });
    expect(rules(findings)).toEqual(["E2"]);
    expect(findings[0].detail).toContain("statement 2 rather than the first");
  });

  // Data-driven over the REGISTRY, not written per capability. BACKLOG-2962's
  // seams PR added three entries after this case was written for one, and a
  // hand-listed version would have grown a coverage hole every time the list
  // did — silently, because a missing case cannot fail.
  it.each(NATIVE_CAPABILITIES.map((c) => [c.name, c.installFunction]))(
    "C1 — deleting %s's install call from the REAL composition root names it, and ONLY it",
    (name, installFunction) => {
      const findings = check({
        compositionRootSource: REAL_ROOT_SOURCE.split("\n")
          .filter((l) => !l.trimStart().startsWith(`${installFunction}(`))
          .join("\n"),
      });
      expect(subjects(findings)).toEqual([name]);
      expect(findings[0].rule).toBe("C1");
    },
  );

  it("that deletion case is not vacuous: every install call it removes is really in the file", () => {
    // If an `installFunction` were misspelled in the registry, the filter above
    // would remove nothing, the guard would find nothing missing, and `toEqual`
    // would red — but for a confusing reason. This says the real reason first.
    for (const capability of NATIVE_CAPABILITIES) {
      expect(REAL_ROOT_SOURCE).toContain(`${capability.installFunction}(`);
    }
  });

  it("C1 — deleting the RUNTIME guard's own call is caught, so the guard guards its guard", () => {
    const findings = check({
      compositionRootSource: REAL_ROOT_SOURCE.split("\n")
        .filter((l) => !l.trimStart().startsWith("assertNativeCapabilitiesInstalled("))
        .join("\n"),
    });
    expect(subjects(findings)).toEqual(["the runtime self-check"]);
  });

  it("C1 — a LOCALLY DECLARED function of the same name does not count (not a name-string match)", () => {
    const findings = check({
      compositionRootSource: [
        `import { ElectronSecretStore } from "../capabilities/electron/electronSecretStore";`,
        `import { assertNativeCapabilitiesInstalled } from "../capabilities/nativeCapabilities";`,
        ``,
        `function installSecretStore(_s: unknown): void { /* not the provider's */ }`,
        `installSecretStore(new ElectronSecretStore());`,
        `assertNativeCapabilitiesInstalled();`,
      ].join("\n"),
      requiredCalls: SECRET_STORE_ONLY,
    });
    expect(subjects(findings)).toEqual(["secretStore"]);
  });

  it("C1 — the name appearing only in a comment or a string literal does not count", () => {
    // The exact defect that mis-measured this item three times: a mention
    // counted as a call.
    const findings = check({
      compositionRootSource: [
        `import { assertNativeCapabilitiesInstalled } from "../capabilities/nativeCapabilities";`,
        `// installSecretStore(new ElectronSecretStore());`,
        `/** calls installSecretStore() at boot */`,
        `const note = "installSecretStore(new ElectronSecretStore())";`,
        `void note;`,
        `assertNativeCapabilitiesInstalled();`,
      ].join("\n"),
      requiredCalls: SECRET_STORE_ONLY,
    });
    expect(subjects(findings)).toEqual(["secretStore"]);
  });

  it("C1 — an import of the right NAME from the WRONG module does not count", () => {
    const findings = check({
      compositionRootSource: [
        `import { installSecretStore } from "../capabilities/someOtherProvider";`,
        `import { assertNativeCapabilitiesInstalled } from "../capabilities/nativeCapabilities";`,
        `installSecretStore(null);`,
        `assertNativeCapabilitiesInstalled();`,
      ].join("\n"),
      requiredCalls: SECRET_STORE_ONLY,
    });
    expect(subjects(findings)).toEqual(["secretStore"]);
  });

  it("C1 — a type-only import cannot satisfy it (it is erased and calls nothing)", () => {
    const findings = check({
      compositionRootSource: [
        `import type { installSecretStore } from "../capabilities/secretStoreProvider";`,
        `import { assertNativeCapabilitiesInstalled } from "../capabilities/nativeCapabilities";`,
        `assertNativeCapabilitiesInstalled();`,
      ].join("\n"),
      requiredCalls: SECRET_STORE_ONLY,
    });
    expect(subjects(findings)).toEqual(["secretStore"]);
  });

  // ---- CONTROL 4: a second capability, registered with no installer ----
  it("C1 — a SECOND capability with no installer is named SPECIFICALLY, and secretStore is not", () => {
    // A guard that reports "something is missing" is a name-matcher for the one
    // case it was built against. This proves it discriminates between two.
    const withDummy: RequiredCall[] = [
      ...REQUIRED,
      {
        name: "messageIngestion",
        providerModule: "electron/capabilities/messageIngestionProvider",
        installFunction: "installMessageIngestion",
      },
    ];
    const findings = check({ requiredCalls: withDummy });

    expect(subjects(findings)).toEqual(["messageIngestion"]);
    expect(subjects(findings)).not.toContain("secretStore");
    expect(findings[0].detail).toContain("installMessageIngestion");
    expect(findings[0].detail).toContain("electron/capabilities/messageIngestionProvider");
  });

  it("C1 — with TWO capabilities uninstalled, BOTH are named, in registry order", () => {
    const two: RequiredCall[] = [
      { name: "alpha", providerModule: "electron/capabilities/alpha", installFunction: "installAlpha" },
      { name: "beta", providerModule: "electron/capabilities/beta", installFunction: "installBeta" },
    ];
    expect(subjects(check({ requiredCalls: two }))).toEqual(["alpha", "beta"]);
  });
});

// ===========================================================================
// MUST NOT FIRE — valid shapes the guard has to accept
// ===========================================================================

describe("composition-root guard: must not fire", () => {
  it("a different-but-valid import path in the entry module (resolved, not string-compared)", () => {
    expect(
      check({ entrySource: `import "./bootstrap/../bootstrap/installNativeCapabilities";\n` }),
    ).toEqual([]);
  });

  it("an explicit source extension on the specifier", () => {
    expect(check({ entrySource: `import "./bootstrap/installNativeCapabilities.js";\n` })).toEqual([]);
  });

  it("the entry import placed LAST rather than first — position is not the contract", () => {
    expect(
      check({
        entrySource: [
          `import { app } from "electron";`,
          `void app;`,
          `import "./bootstrap/installNativeCapabilities";`,
        ].join("\n"),
      }),
    ).toEqual([]);
  });

  it("E2 — a different-but-valid path to the app-data override (resolved, not string-compared)", () => {
    expect(
      check({
        entrySource: [
          `import "./bootstrap/../bootstrap/installAppDataPaths";`,
          `import "./bootstrap/installNativeCapabilities";`,
          ``,
        ].join("\n"),
        requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
      }),
    ).toEqual([]);
  });

  it("E2 — an explicit source extension on the app-data specifier", () => {
    expect(
      check({
        entrySource: [
          `import "./bootstrap/installAppDataPaths.js";`,
          `import "./bootstrap/installNativeCapabilities";`,
          ``,
        ].join("\n"),
        requiredCalls: [],
      requiredEntryImports: APP_DATA_IMPORT,
      }),
    ).toEqual([]);
  });

  it("E2 — the position rule is READ from the entry, not assumed: mustBeFirstStatement false accepts any position", () => {
    // Without this, E2 would be indistinguishable from a rule that always
    // demands first position, and the registry flag would be decoration.
    const positionFree: RequiredEntryImport[] = [
      { ...APP_DATA_IMPORT[0], mustBeFirstStatement: false },
    ];
    expect(
      check({
        entrySource: [
          `import "./bootstrap/installNativeCapabilities";`,
          `import "./bootstrap/installAppDataPaths";`,
          ``,
        ].join("\n"),
        requiredCalls: [],
        requiredEntryImports: positionFree,
      }),
    ).toEqual([]);
  });

  it("E1, E2 and C1 armed at once produce no findings between them", () => {
    // The real-tree E2 case filters E1 away, and every other E2 case here
    // silences C1, so that one mutation reds one test. This is the case that
    // arms all three at once, so "each case proves one rule" cannot be hiding a
    // rule that fires on correct input the moment its neighbours are present.
    // Its composition root is hand-written rather than the real file's —
    // specifiers transcribed verbatim from `installNativeCapabilities.ts` lines
    // 29-31 — so deleting the real install line does not red this case along
    // with the ones that are about it.
    expect(
      check({
        entrySource: VALID_ENTRY_WITH_BOOTSTRAP,
        compositionRootSource: [
          `import { installSecretStore } from "../capabilities/secretStoreProvider";`,
          `import { ElectronSecretStore } from "../capabilities/electron/electronSecretStore";`,
          `import { assertNativeCapabilitiesInstalled } from "../capabilities/nativeCapabilities";`,
          `installSecretStore(new ElectronSecretStore());`,
          `assertNativeCapabilitiesInstalled();`,
        ].join("\n"),
        requiredCalls: SECRET_STORE_ONLY,
        requiredEntryImports: APP_DATA_IMPORT,
      }),
    ).toEqual([]);
  });

  it("two capabilities installed in EITHER order", () => {
    const two: RequiredCall[] = [
      { name: "alpha", providerModule: "electron/capabilities/alpha", installFunction: "installAlpha" },
      { name: "beta", providerModule: "electron/capabilities/beta", installFunction: "installBeta" },
    ];
    const forwards = [
      `import { installAlpha } from "../capabilities/alpha";`,
      `import { installBeta } from "../capabilities/beta";`,
      `installAlpha();`,
      `installBeta();`,
    ].join("\n");
    const backwards = [
      `import { installBeta } from "../capabilities/beta";`,
      `import { installAlpha } from "../capabilities/alpha";`,
      `installBeta();`,
      `installAlpha();`,
    ].join("\n");

    expect(check({ compositionRootSource: forwards, requiredCalls: two })).toEqual([]);
    expect(check({ compositionRootSource: backwards, requiredCalls: two })).toEqual([]);
  });

  it("a namespace import — p.installSecretStore(...)", () => {
    expect(
      check({
        compositionRootSource: [
          `import * as provider from "../capabilities/secretStoreProvider";`,
          `import * as caps from "../capabilities/nativeCapabilities";`,
          `import { ElectronSecretStore } from "../capabilities/electron/electronSecretStore";`,
          `provider.installSecretStore(new ElectronSecretStore());`,
          `caps.assertNativeCapabilitiesInstalled();`,
        ].join("\n"),
        requiredCalls: SECRET_STORE_ONLY,
      }),
    ).toEqual([]);
  });

  it("an aliased named import — { installSecretStore as install }", () => {
    expect(
      check({
        compositionRootSource: [
          `import { installSecretStore as install } from "../capabilities/secretStoreProvider";`,
          `import { assertNativeCapabilitiesInstalled as verify } from "../capabilities/nativeCapabilities";`,
          `import { ElectronSecretStore } from "../capabilities/electron/electronSecretStore";`,
          `install(new ElectronSecretStore());`,
          `verify();`,
        ].join("\n"),
        requiredCalls: SECRET_STORE_ONLY,
      }),
    ).toEqual([]);
  });

  it("a require() destructure — the repo already uses lazy require elsewhere", () => {
    expect(
      check({
        compositionRootSource: [
          `const { installSecretStore } = require("../capabilities/secretStoreProvider");`,
          `const caps = require("../capabilities/nativeCapabilities");`,
          `installSecretStore({});`,
          `caps.assertNativeCapabilitiesInstalled();`,
        ].join("\n"),
        requiredCalls: SECRET_STORE_ONLY,
      }),
    ).toEqual([]);
  });

  it("a call nested inside a block or a try — C1 is a reachability floor, not a control-flow proof", () => {
    // Stated plainly because it is a LIMIT, not a feature: C1 asks whether the
    // call expression exists, not whether it executes. The runtime layer is
    // what answers "did it actually install".
    expect(
      check({
        compositionRootSource: [
          `import { installSecretStore } from "../capabilities/secretStoreProvider";`,
          `import { assertNativeCapabilitiesInstalled } from "../capabilities/nativeCapabilities";`,
          `import { ElectronSecretStore } from "../capabilities/electron/electronSecretStore";`,
          `try { installSecretStore(new ElectronSecretStore()); } catch { /* */ }`,
          `assertNativeCapabilitiesInstalled();`,
        ].join("\n"),
        requiredCalls: SECRET_STORE_ONLY,
      }),
    ).toEqual([]);
  });
});

// ===========================================================================
// The resolver itself — the piece a line matcher would get wrong
// ===========================================================================

describe("resolveSpecifier", () => {
  it.each([
    ["electron/main.ts", "./bootstrap/installNativeCapabilities", "electron/bootstrap/installNativeCapabilities"],
    ["electron/main.ts", "./bootstrap/../bootstrap/installNativeCapabilities", "electron/bootstrap/installNativeCapabilities"],
    ["electron/main.ts", "./bootstrap/installNativeCapabilities.ts", "electron/bootstrap/installNativeCapabilities"],
    ["electron/bootstrap/installNativeCapabilities.ts", "../capabilities/secretStoreProvider", "electron/capabilities/secretStoreProvider"],
    ["electron/bootstrap/installNativeCapabilities.ts", "../capabilities/secretStoreProvider/index", "electron/capabilities/secretStoreProvider"],
  ])("%s + %s -> %s", (from, spec, expected) => {
    expect(resolveSpecifier(from, spec)).toBe(expected);
  });

  it("returns null for bare and aliased specifiers, which it does not claim to resolve", () => {
    expect(resolveSpecifier("electron/main.ts", "electron")).toBeNull();
    expect(resolveSpecifier("electron/main.ts", "@electron/bootstrap/installNativeCapabilities")).toBeNull();
  });
});
