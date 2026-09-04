/**
 * BACKLOG-3067 — the escape ratchet.
 *
 * A brand is only worth what its escapes cost. Both BACKLOG-3064 and this item
 * record the same discipline: "a tolerated escape hatch, counted, only ever
 * shrinking", and "a migration whose tolerated-exception count can rise is not a
 * migration."
 *
 * This suite asserts the EXACT SET — file path to count — not a `<=` threshold.
 * A threshold is the drift it is supposed to prevent: under `<= 12` you can add
 * six escapes and stay green, and nobody finds out until someone counts by hand.
 * Under an exact map, adding, moving or removing one fails here, with the diff
 * printed, and whoever did it has to say so in the PR.
 *
 * The sets are derived by EXECUTION, not by grep and not by memory: files are
 * walked, parsed with the TypeScript compiler, and matched as AST nodes. A token
 * grep finds the name, not the property — it counts mentions in comments and
 * strings as real code (this very file's own prose would inflate the number, and
 * so would the long explanatory comment beside the escape in
 * `hybridExtractorService.ts`).
 *
 * ## WHAT THIS MATCHER COVERS, AND WHAT IT DOES NOT
 *
 * Stated because the previous version implied completeness it did not have, and a
 * false completeness claim is worse than an unclaimed limit: an unclaimed limit
 * leaves the next reader looking, and a false claim stops them.
 *
 * COVERED — DIRECT SYNTACTIC ASSERTIONS THAT NAME THE BRAND. Not "every way":
 *
 *   asCommunicationId(raw)                 the named helper (CallExpression)
 *   raw as CommunicationId                 AsExpression
 *   <CommunicationId>raw                   TypeAssertionExpression
 *   raw as ids.CommunicationId             QualifiedName, resolved rightmost
 *   raw as (CommunicationId)               ParenthesizedType, resolved through
 *   raw as CommunicationId | undefined     UnionType, any member
 *   raw as CommunicationId & { z?: 1 }     IntersectionType, any member
 *   raw as CommunicationId[]               ArrayType, resolved to its element
 *
 * All eight were PLANTED one at a time in production code
 * (`communicationDbService.ts`) and each was observed to take this suite red, then
 * removed and observed green, against a green baseline. A matcher whose coverage
 * has never been made to fail is a list of hopes.
 *
 * NOT COVERED — AND THIS IS A PROPERTY OF THE APPROACH, NOT A GAP TO PATCH.
 *
 * `namesABrand()` descends through type-node wrappers and then compares a NAME
 * against a hard-coded set. **TypeScript can name one type in unboundedly many
 * ways, so no name-set matcher can be exhaustive over type identity**, however
 * deep it descends. Four indirections walk past this one today — an alias
 * declaration, an import alias, a utility type, and an indexed access:
 *
 *   raw as CommunicationRow["id"]          // same type, different name
 *
 * Closing that needs the type CHECKER (resolve each node to its type and compare
 * identity), not a longer list of spellings. **BACKLOG-3072 owns it.**
 *
 * Separately, `const x: CommunicationId = raw as any` launders through `any`: it
 * names no brand and makes no claim about one — it switches checking off wholesale.
 * That is a lint rule's job, not this ratchet's. The named owner,
 * `@typescript-eslint/no-explicit-any`, is `warn` today and therefore blocks
 * nothing; **BACKLOG-3073 owns that.**
 *
 * Not covered and correctly so: `raw satisfies CommunicationId` launders nothing,
 * because `satisfies` CHECKS assignability rather than asserting it. Executed
 * rather than assumed — that expression is `TS1360: Type 'string' does not satisfy
 * the expected type 'CommunicationId'`, so it cannot reach a call site at all.
 *
 * ## The diagnosis, recorded because this is the fifth instance
 *
 * Both holes found in this guard were the same defect: MATCHING THE WRONG NODE
 * KIND. First it matched only CallExpressions, so every inline `as` was invisible.
 * Then it matched AsExpression with a bare TypeReference, so four wrappers —
 * angle-bracket syntax, a namespace qualifier, parentheses, a union — walked
 * through. Neither was "a missing pattern to add"; both were a matcher that
 * stopped descending too early. The fix both times was to match the right node
 * kinds and RESOLVE THROUGH the wrappers, never to enumerate spellings — an
 * enumeration is only ever as long as the last person's imagination.
 */
import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SEARCH_ROOTS = ["electron", "src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", "build", ".git", "coverage"]);

/** Where the brands are DEFINED. Its own `as X` returns are the mechanism, not escapes. */
const BRAND_MODULE = path.join("electron", "types", "ids.ts");

/**
 * This file. Excluded from its own corpus: it necessarily contains the names of
 * everything it searches for, and a guard that counts itself measures nothing.
 */
const SELF = path.join("electron", "types", "__tests__", "brandedIds.escapeSet.test.ts");

const MINT_HELPERS = new Set(["asCommunicationId", "asEmailId", "asTransactionId"]);

/**
 * The named helpers are not the only way to brand a string — an inline type
 * assertion does the same thing invisibly. See the file header for exactly which
 * assertion forms are matched, which one is not, and why that one belongs to a
 * lint rule instead.
 */
const BRAND_TYPES = new Set([
  "CommunicationId",
  "EmailId",
  "TransactionId",
  "CommunicationRow",
  "EmailRow",
  "TransactionRow",
]);

/**
 * PRE-REGISTERED, and the reason for each.
 *
 * CATEGORY 1 — known-defect escapes. `@ts-expect-error` citing BACKLOG-2829, at the
 * two places that record a defect this item deliberately does NOT fix. A mint
 * helper would have compiled too and would have ASSERTED something false ("this
 * email id is a communication id") in the two places whose whole purpose is to
 * record that it is not. These directives also self-remove: once 2829 is fixed and
 * the types line up, TypeScript reports TS2578 for an unused directive and CI stays
 * red until the comment is deleted. The ratchet is in the language.
 */
const EXPECTED_DEFECT_ESCAPES: Record<string, number> = {
  // The live defect. An `emails.id` passed into the `communicationId` parameter:
  // the UPDATE matches zero rows and the caller logs success.
  "electron/services/extraction/hybridExtractorService.ts": 1,
  // The characterization suite that executes that call and pins what it does.
  "electron/services/db/__tests__/communicationDbService.relinkGaps-2565.test.ts": 1,
};

/**
 * CATEGORY 3 — inline `as <brand>` assertions, the form the named helpers exist to
 * replace. Listed rather than banned outright, because three of them ARE the
 * mechanism and two predate this item:
 *
 *   - `ids.ts` — the three helper bodies. A brand has to be conjured somewhere.
 *   - `communicationDbService.ts` — two `as unknown as CommunicationRow`. NOT new:
 *     both were already `as unknown as Communication`, because those objects are
 *     assembled in memory instead of being re-SELECTed (BACKLOG-1107). Retargeting
 *     an existing assertion adds nothing; pinning them here means a THIRD one
 *     cannot appear quietly.
 *   - `brandedIds.runtimeIdentity.test.ts` — one, in control 4, looking a `Map` up
 *     with a differently-typed handle to prove the two are the same runtime key.
 *
 * Production code adds no new inline brand cast, and this assertion is what makes
 * that a measured claim rather than a sentence in a PR body.
 */
const EXPECTED_INLINE_BRAND_CASTS: Record<string, number> = {
  "electron/types/ids.ts": 3,
  "electron/services/db/communicationDbService.ts": 2,
  "electron/types/__tests__/brandedIds.runtimeIdentity.test.ts": 1,
};

/**
 * CATEGORY 2 — mints. Unchecked assertions that a bare string is a particular kind
 * of row id. Every one is in a TEST, on a fabricated literal with no database row
 * behind it, so there is no read to earn the brand from. **Zero in production
 * code** — that is the line this guard is really holding, and the assertion below
 * states it separately so it cannot be lost in a total.
 */
const EXPECTED_MINTS: Record<string, number> = {
  "electron/services/db/__tests__/communicationDbService.relinkGaps-2565.test.ts": 1,
  "electron/services/__tests__/databaseService.test.ts": 2,
};

/**
 * Calls to the same helpers that are NOT escapes: control 4 exercises
 * `asCommunicationId` / `asEmailId` / `asTransactionId` in order to prove they are
 * runtime no-ops (`===` the raw string, JSON round-trip, object and Map keys). They
 * stand in for no missing database read; they ARE the subject under test.
 *
 * They are listed rather than filtered out. An exclusion rule is a place for an
 * escape to hide, and this guard's only real product is that the measured map is
 * complete — so the corpus stays whole and the categories are separated here, in
 * the open, where the subtotal that matters (`EXPECTED_MINTS`) is still visible.
 */
const EXPECTED_CONTROL_CALLS: Record<string, number> = {
  "electron/types/__tests__/brandedIds.runtimeIdentity.test.ts": 9,
};

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function sourceFiles(): string[] {
  const found: string[] = [];
  for (const root of SEARCH_ROOTS) walk(path.join(REPO_ROOT, root), found);
  return found
    .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"))
    .filter((f) => f !== SELF.split(path.sep).join("/"))
    .sort();
}

/** Mint call sites, matched as AST call expressions — never as text. */
function countMints(relPath: string, text: string): number {
  return countNodes(relPath, text, (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    MINT_HELPERS.has(node.expression.text),
  );
}

/**
 * The rightmost identifier of an entity name: `CommunicationId` for a bare
 * reference, and also for `ids.CommunicationId` or `a.b.CommunicationId`. A
 * qualified name is the same assertion wearing a namespace import.
 */
function rightmostName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

/**
 * Does this type node NAME a brand, at any depth a type-assertion can wrap one in?
 *
 * Recursive on purpose. The first version of this guard tested
 * `ts.isTypeReferenceNode(node.type)` directly, so `raw as (CommunicationId)`,
 * `raw as CommunicationId | undefined` and `raw as ids.CommunicationId` all
 * slipped past — each is a wrapper the matcher did not descend through, not a
 * different kind of escape.
 */
function namesABrand(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isParenthesizedTypeNode(type)) return namesABrand(type.type);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(namesABrand);
  }
  if (ts.isArrayTypeNode(type)) return namesABrand(type.elementType);
  if (ts.isTypeReferenceNode(type)) return BRAND_TYPES.has(rightmostName(type.typeName));
  return false;
}

/**
 * Inline type assertions that claim a value is branded, in BOTH of TypeScript's
 * assertion syntaxes: `expr as T` (`AsExpression`) and `<T>expr`
 * (`TypeAssertionExpression`).
 *
 * `<T>expr` is unavailable in `.tsx` — TypeScript parses it as JSX — and this is
 * handled for free rather than special-cased: `ts.createSourceFile` derives the
 * script kind from the file name it is given, so a `.tsx` file in the corpus is
 * parsed with JSX rules and cannot produce a `TypeAssertionExpression` at all.
 */
function countInlineBrandCasts(relPath: string, text: string): number {
  return countNodes(
    relPath,
    text,
    (node) =>
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      namesABrand(node.type),
  );
}

function countNodes(relPath: string, text: string, match: (node: ts.Node) => boolean): number {
  const source = ts.createSourceFile(relPath, text, ts.ScriptTarget.ES2020, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (match(node)) count += 1;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return count;
}

/**
 * Directive comments citing BACKLOG-2829. Anchored to the start of a line, which is
 * the only position TypeScript honours the directive in — so prose that merely
 * MENTIONS it (as the comment beside each escape does, at length) cannot be counted.
 */
function countDefectEscapes(text: string): number {
  return text.split("\n").filter((line) => /^\s*\/\/\s*@ts-expect-error\s+BACKLOG-2829\b/.test(line))
    .length;
}

function measure(counter: (relPath: string, text: string) => number): Record<string, number> {
  const measured: Record<string, number> = {};
  for (const relPath of sourceFiles()) {
    const text = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
    const n = counter(relPath, text);
    if (n > 0) measured[relPath] = n;
  }
  return measured;
}

describe("BACKLOG-3067 — the escape set is exactly what the PR says it is", () => {
  it("finds a corpus to search (a guard over zero files always passes)", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("electron/services/db/communicationDbService.ts");
    expect(files).toContain("electron/services/extraction/hybridExtractorService.ts");
  });

  it("has exactly two known-defect escapes, both citing BACKLOG-2829", () => {
    expect(measure((_, text) => countDefectEscapes(text))).toEqual(EXPECTED_DEFECT_ESCAPES);
  });

  it("calls the mint helpers in exactly the places the PR names — nothing filtered", () => {
    // The whole measured map, with nothing excluded from the corpus.
    expect(measure(countMints)).toEqual({ ...EXPECTED_MINTS, ...EXPECTED_CONTROL_CALLS });
  });

  it("has exactly three mint ESCAPES, and not one of them is in production code", () => {
    const measured = measure(countMints);
    const escapes = Object.fromEntries(
      Object.entries(measured).filter(([f]) => !(f in EXPECTED_CONTROL_CALLS)),
    );

    expect(escapes).toEqual(EXPECTED_MINTS);
    expect(Object.values(escapes).reduce((a, b) => a + b, 0)).toBe(3);

    // The line this guard is really holding. A mint in production code means a
    // write took an id on somebody's word instead of reading the row first.
    const production = Object.keys(measured).filter(
      (f) => !f.includes("__tests__") && !/\.test\.tsx?$/.test(f),
    );
    expect(production).toEqual([]);
  });

  /**
   * The matchers have to be able to tell a call from a mention, or the numbers
   * above are noise. Both corner cases exist in the tree right now, deliberately:
   * `relinkGaps-2565.test.ts` explains in a comment why it stopped writing
   * `asTransactionId(TX_NEW)` at three call sites, and `hybridExtractorService.ts`
   * explains at length why its escape is a directive and not a mint.
   */
  it("counts calls and directives, not mentions of them", () => {
    const withMintInAComment = "electron/services/db/__tests__/communicationDbService.relinkGaps-2565.test.ts";
    const text = fs.readFileSync(path.join(REPO_ROOT, withMintInAComment), "utf8");

    // The text says it more often than the program does. That gap is the whole
    // reason this is an AST match: a grep would report the larger number.
    const mentions = (text.match(/asTransactionId\s*\(/g) ?? []).length;
    expect(mentions).toBeGreaterThan(countMints(withMintInAComment, text));
    expect(countMints(withMintInAComment, text)).toBe(1);

    const escapeFile = "electron/services/extraction/hybridExtractorService.ts";
    const escapeText = fs.readFileSync(path.join(REPO_ROOT, escapeFile), "utf8");
    expect(escapeText.split("@ts-expect-error").length - 1).toBeGreaterThan(1);
    expect(countDefectEscapes(escapeText)).toBe(1);
  });

  it("brands inline in exactly the places the PR names, and nowhere new in production", () => {
    const measured = measure(countInlineBrandCasts);
    expect(measured).toEqual(EXPECTED_INLINE_BRAND_CASTS);

    // The two in `communicationDbService.ts` are the retargeted BACKLOG-1107
    // assertions, and they are the ONLY inline brand casts in production code.
    const production = Object.keys(measured).filter(
      (f) => !f.includes("__tests__") && !/\.test\.tsx?$/.test(f) && f !== BRAND_MODULE.split(path.sep).join("/"),
    );
    expect(production).toEqual(["electron/services/db/communicationDbService.ts"]);
  });

  /**
   * The brand module's own `as CommunicationId` returns are the mechanism, not
   * escapes — but they are the ONLY place a raw string may become branded without
   * a database read, so they are pinned here too. If a fourth helper appears, or
   * one of these grows a caller in production code, the assertions above change
   * and someone has to say why.
   */
  it("mints brands in exactly one module", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, BRAND_MODULE), "utf8");
    const source = ts.createSourceFile(BRAND_MODULE, text, ts.ScriptTarget.ES2020, true);

    const exportedFunctions: string[] = [];
    ts.forEachChild(source, (node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exportedFunctions.push(node.name.text);
      }
    });

    expect(exportedFunctions.sort()).toEqual(["asCommunicationId", "asEmailId", "asTransactionId"]);
  });
});
