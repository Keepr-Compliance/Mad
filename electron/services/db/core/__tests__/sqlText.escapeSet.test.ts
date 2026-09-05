/**
 * BACKLOG-3064 — the escape ratchet. Controls 3 and 5.
 *
 * A brand is only worth what its escapes cost. This item's own body sets the rule:
 * *"a tolerated escape hatch, counted and only ever shrinking"*, and *"a migration
 * whose tolerated-exception count can rise is not a migration."*
 *
 * This suite asserts the EXACT SET — file path to count, with an owner for each
 * file — not a `<=` threshold. A threshold is the drift it is supposed to prevent:
 * under `<= 400` you can add six escapes and stay green, and nobody finds out until
 * someone counts by hand. Under an exact map, adding, moving or removing one fails
 * here, with the diff printed, and whoever did it has to say so in the PR.
 *
 * **There is no default owner and no fall-through.** A file that is not named in
 * the map goes red rather than inheriting a category. This epic has been caught by
 * a `DEFAULT_OWNER` fall-through twice already — at `contactQueryWorker` and again
 * at chunk 5 — and the third one is only waiting for somewhere to hide.
 *
 * The sets are derived by EXECUTION, not by grep and not by memory: files are
 * walked, parsed with the TypeScript compiler, and matched as AST nodes. A token
 * grep finds the NAME, not the property — it counts mentions in comments and
 * strings as real code, and this very file's prose would inflate the number, as
 * would the long header on `sqlText.ts`.
 *
 * ## WHAT THIS MATCHER COVERS, AND WHAT IT DOES NOT
 *
 * Copied — deliberately together with its limits — from
 * `electron/types/__tests__/brandedIds.escapeSet.test.ts` (BACKLOG-3067), AFTER
 * that matcher was fixed twice. Stating the limit rather than implying completeness
 * is the point: a false completeness claim is worse than an unclaimed limit,
 * because an unclaimed limit leaves the next reader looking and a false claim stops
 * them.
 *
 * COVERED — the named escape, and direct syntactic assertions that NAME the brand:
 *
 *   unsafeSql(text)                   the named escape (CallExpression)
 *   raw as SafeSql                    AsExpression
 *   <SafeSql>raw                      TypeAssertionExpression
 *   raw as sqlText.SafeSql            QualifiedName, resolved rightmost
 *   raw as (SafeSql)                  ParenthesizedType, resolved through
 *   raw as SafeSql | undefined        UnionType, any member
 *   raw as SafeSql & { z?: 1 }        IntersectionType, any member
 *   raw as SafeSql[]                  ArrayType, resolved to its element
 *
 * NOT COVERED — AND THIS IS A PROPERTY OF THE APPROACH, NOT A GAP TO PATCH.
 *
 * `namesTheBrand()` descends through type-node wrappers and then compares a NAME
 * against a set. **TypeScript can name one type in unboundedly many ways, so no
 * name-set matcher can be exhaustive over type identity**, however deep it
 * descends. An alias declaration, an import alias, a utility type and an indexed
 * access all walk past it. Closing that needs the type CHECKER — resolve each node
 * to its type and compare identity — not a longer list of spellings.
 * **BACKLOG-3072 owns it.**
 *
 * Separately, `const x: SafeSql = raw as any` launders through `any`: it names no
 * brand and makes no claim about one, it switches checking off wholesale. That is a
 * lint rule's job. The named owner, `@typescript-eslint/no-explicit-any`, is `warn`
 * today and therefore blocks nothing; **BACKLOG-3073 owns that.**
 *
 * ## What makes THIS item's brand harder to forge than BACKLOG-3067's
 *
 * `SafeSql` is carried by a `unique symbol` that `sqlText.ts` does not export, so
 * unlike a string-literal brand it **cannot be re-declared structurally** by
 * someone who types the same literal in their own file. Nothing outside the module
 * can name the symbol. Control 3 proves this matcher can see a violation, by
 * planting one in three files and three syntaxes.
 *
 * **What that does NOT mean — and this paragraph used to claim otherwise.** It said
 * "every remaining forgery has to NAME `SafeSql`, which is the node kind matched
 * here", and that was false. BACKLOG-3086 compiled 23 forms one at a time: 19
 * reached a conduit parameter with an unbranded value, and two whole FAMILIES of
 * them never mention the type in any spelling — so no matcher over assertion nodes
 * can see those BY CONSTRUCTION, however many spellings it learns:
 *
 *   dbAll as (s: string, p?: unknown[]) => unknown[]         the CONDUIT is widened,
 *   const c: { all(s: string): unknown[] } = { all: dbAll }  not the argument cast
 *
 *   function launder(s: string): SafeSql;                    an overload signature
 *   function launder(s: string): string { return s; }        with no checked body
 *
 * Both families are held by `sqlText.conduitSeam.test.ts`, which resolves symbols and
 * type identity through the checker. THIS matcher is unchanged by that item: what was
 * wrong was the completeness claim, not the counts below.
 */
import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const SEARCH_ROOTS = ["electron", "src", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "build",
  ".git",
  "coverage",
]);

/**
 * Where the brand is DEFINED. Its own `as SafeSql` returns are the mechanism, not
 * escapes — a brand has to be conjured somewhere — so they are counted separately
 * and pinned rather than folded into the total.
 */
const BRAND_MODULE = "electron/services/db/core/sqlText.ts";

/**
 * The type fixtures. Six of the seven are SUPPOSED not to compile; they are
 * excluded from every tsconfig and from eslint, and they are excluded here too —
 * their whole job is to contain the shapes this suite hunts for.
 */
const FIXTURE_DIR = "electron/types/__typefixtures__/";

/**
 * This file. Excluded from its own corpus: it necessarily contains the names of
 * everything it searches for, and a guard that counts itself measures nothing.
 */
const SELF = "electron/services/db/core/__tests__/sqlText.escapeSet.test.ts";

/**
 * PRE-REGISTERED — declared in Supabase (`pm_comments`) BEFORE the first production
 * edit, and reproduced here.
 *
 * Every entry was inserted mechanically by BACKLOG-3064 commit 1, which wrapped each
 * existing conduit call site's SQL argument and changed nothing else. The SQL text
 * reaching SQLite was byte-identical: all 393 arg0 slices hashed to the same
 * aggregate before and after
 * (`ba18ad1f9788de6847a388cede0dd95a587bf624b14c7044f13e4ac0aedcb513`).
 *
 * ## 2026-09-04 — BACKLOG-3085 removed the in-layer half. 393 -> 135.
 *
 * 258 of the 262 rows owned by `BACKLOG-3064` were removed BY CONVERSION: the
 * statement now goes through the `sql` tag. No row was deleted, none left by
 * `--allow-growth`, and no baseline was regenerated — this map is compared against a
 * measurement, so a row can only leave when its escape actually leaves.
 *
 * **Four did not convert, and they are still here rather than gone.** In each, the
 * tag refuses a splice because a VALUE is pasted into SQL text: a row limit
 * (`LIMIT ${Number(limit)}`) and, three times, a provider list hand-quoted into a
 * predicate by `emailForceReadView`. Fixing either CHANGES the statement, so neither
 * belongs inside a byte-identical conversion. They are re-owned to **BACKLOG-3102**,
 * which is what the owner column is for.
 *
 * ## A count correction, found by re-deriving rather than by reading
 *
 * The `BACKLOG-3064` note below used to read *"22 files, plus 2 test files"*.
 * Measured: **23 production files plus 1 test file**
 * (`db/__tests__/transactionDbService.cardScope-2865.test.ts`, which held both of the
 * 2 test escapes). The total of 24 was right; the split was not.
 *
 * ## 2026-09-04 — BACKLOG-3044 moved its first 45 out of the layer's blind spot. 135 -> 90.
 *
 * Six files left this map entirely, and every one of them left BY MOVING: the statement
 * is now authored inside `electron/services/db/**` behind the `sql` tag, and the caller
 * passes the exported constant to the same conduit it always called.
 *
 *   electron/services/reviewStateService.ts     23  ->  db/reviewStateSql.ts
 *   electron/services/failureLogService.ts      11  ->  db/failureLogSql.ts
 *   electron/services/ccpaExportService.ts       5  ->  db/ccpaExportSql.ts
 *   electron/services/auditCoverageService.ts    3  ->  db/auditCoverageSql.ts
 *   electron/handlers/licenseHandlers.ts         2  ->  db/localUserSql.ts
 *   electron/services/contactAutoLinkPolicy.ts   1  ->  db/localUserSql.ts
 *
 * No row was deleted to quiet the check and no baseline was regenerated. This map is
 * compared against a measurement, so a row can only leave when its escape actually
 * leaves — and the count that replaced it was re-derived by execution, not edited to
 * match. The SQL text is byte-identical across the move, hashed cooked-value by
 * cooked-value by `scripts/ci/sql-move-identity.mjs`.
 *
 * **BACKLOG-3044 is NOT finished at 86.** The remaining 17 files are sequenced as four
 * further PRs in that item's Supabase comments; the split exists because 131 statements
 * across 23 files is not one reviewable diff. Four of the 86 will REFUSE to convert —
 * they interpolate `LIVE_TRANSACTION_SQL_PREDICATE`, which hand-quotes a status VALUE
 * into SQL text — and are BACKLOG-3102's class rather than an obstacle to route around.
 *
 * ## 2026-09-04 — BACKLOG-3044 PR 2 moved the contact family. 90 -> 65.
 *
 * Seven more files left by MOVING, and this time TWO FRAGMENTS moved with them —
 * `PENDING_JOIN` and `onTransaction`, both previously authored in a service and spliced
 * into statements that are now inside the layer. A statement moved into `db/` that still
 * interpolates text from a service is only half moved, which is why these seven are one
 * PR rather than seven.
 *
 *   electron/services/contactCompare.ts           7  ->  db/contactCompareSql.ts
 *   electron/services/contactIdentityEvidence.ts  5  ->  db/contactIdentityEvidenceSql.ts
 *   electron/services/contactLinkEvidence.ts      4  ->  db/contactLinkEvidenceSql.ts
 *   electron/services/contactManualLink.ts        3  ->  db/contactManualLinkSql.ts
 *   electron/services/contactLinkReview.ts        2  ->  db/contactLinkReviewSql.ts
 *   electron/services/contactNameAutoLink.ts      2  ->  db/contactNameAutoLinkSql.ts
 *   electron/services/contactProvenance.ts        2  ->  db/contactProvenanceSql.ts
 *
 * The moving fragments needed a control of their own: `sql-move-identity.mjs` compares a
 * statement's SKELETON and renders each interpolation as a marker, so it cannot see
 * inside a fragment. `db/__tests__/contactFragments.movedText.test.ts` pins both to their
 * exact pre-move bytes, generated from the base tree rather than transcribed.
 *
 * 61 escapes remain for this owner, in 10 files, as three further PRs. Four of those 61
 * will REFUSE — they splice `LIVE_TRANSACTION_SQL_PREDICATE`, which hand-quotes a status
 * VALUE into SQL text — and are **BACKLOG-3103**'s work, not a matter of trying harder.
 *
 * ## 2026-09-04 — BACKLOG-3044 PR 3 took the crosswalk family. 65 -> 53.
 *
 * Three more files left, and ELEVEN of the twelve left by MOVING:
 *
 *   electron/handlers/contactHandlers.ts        3 moved  ->  db/contactHandlersSql.ts
 *   electron/services/contactSourceLinker.ts    4 moved  ->  db/contactSourceLinkerSql.ts
 *   electron/services/contactSourceValues.ts    4 moved  ->  db/contactSourceValuesSql.ts
 *
 * **The twelfth was not a move, and it is the first of its kind in this item.**
 * `contactHandlers.ts:910` passed `CONTACT_SOURCE_RECORDS_SQL`, whose text was ALREADY
 * at `db/contactSourceLinkSql.ts:149` — inside the layer, merely never branded. Its
 * escape left by tagging that constant `sql`. Nothing relocated.
 *
 * That distinction is kept rather than folded into "12 moved" because the reconciliation
 * only means something if each row's reason is true: 11 statements changed file, 1
 * changed nothing but its tag. PR 1 pre-registered this row as its own class before
 * anyone had looked at it, and it arrived exactly as described.
 *
 * The branding was checked against its NON-conduit consumers before being made — the
 * worker thread and six test files call `.prepare(CONTACT_SOURCE_RECORDS_SQL)` on a raw
 * handle. `SafeSql` is `string & {…}`, assignable to every `string` position, so they
 * still receive the same bytes.
 *
 * 49 escapes remain for this owner, in 7 files, as two further PRs. Four of them will
 * REFUSE — `LIVE_TRANSACTION_SQL_PREDICATE` hand-quotes a status VALUE into SQL text —
 * and belong to **BACKLOG-3103**, not to trying harder.
 *
 * ## 2026-09-04 — BACKLOG-3044 PR 4 took the matching and export block. 53 -> 30.
 *
 * Four more files left by MOVING, 23 statements:
 *
 *   electron/services/messageMatchingService.ts                     15
 *   electron/services/transactionService/getEarliestCommunicationDate.ts  4
 *   electron/utils/exportUtils.ts                                    2
 *   electron/handlers/emailLinkingHandlers.ts                        2
 *
 * One of the 23 was assembled from a CONDITIONAL fragment — an optional date window
 * accumulated in the caller beside its `params.push` calls. It moved as a builder taking
 * two BOOLEANS, so the params array stays with the caller in its existing order; clause
 * and bound value are one contract and splitting them across files is BACKLOG-3103's
 * described hazard. All FOUR branches are pinned byte-identical by
 * `db/__tests__/messageMatchingSql.dateFilter.test.ts`, because a builder is
 * byte-identical only if every branch is.
 *
 * 26 escapes remain for this owner, in 3 files — `autoLinkService` (17),
 * `transactionService` (8), `importPlanInputs` (1) — as **PR 5**, which is gated on
 * **BACKLOG-3103**: four of those 26 splice `LIVE_TRANSACTION_SQL_PREDICATE`, which
 * hand-quotes a status VALUE into SQL text.
 *
 * OWNERS, and what each one means:
 *
 *   BACKLOG-3044 — the statement is authored OUTSIDE `electron/services/db/**`.
 *     The escape goes away when the statement MOVES into the layer. 131 in 23 files,
 *     untouched by BACKLOG-3085 — including the ones a newly-branded constant made
 *     redundant, because this map pins them and they are not that item's work.
 *
 *   BACKLOG-3102 — the statement is inside the layer and CANNOT use the tag, because
 *     it splices a value into SQL text. 4 in 2 files.
 *
 * Phase B items re-own these rows as they are filed; the owner column is what makes
 * "who is going to remove this" a fact in CI rather than a memory.
 */
const EXPECTED_ESCAPES: Record<string, { count: number; owner: string }> = {
  "electron/services/db/communicationDbService.ts": { count: 1, owner: "BACKLOG-3102" },
  "electron/services/db/emailSyncSql.ts": { count: 3, owner: "BACKLOG-3102" },
  "electron/services/autoLinkService.ts": { count: 17, owner: "BACKLOG-3044" },
  "electron/services/importPlanInputs.ts": { count: 1, owner: "BACKLOG-3044" },
  "electron/services/transactionService/transactionService.ts": { count: 8, owner: "BACKLOG-3044" },
};

/**
 * Inline `as SafeSql` assertions — the invisible form the named escape exists to
 * replace. Pre-registered as EMPTY except the brand module itself.
 *
 * `sqlText.ts` carries 2: one in `sql` (the tag has to conjure the brand from the
 * cooked template it just assembled) and one in `unsafeSql` (which IS the escape).
 * **Nothing anywhere else in the tree may name the brand in a cast** — that is the
 * line this guard is really holding, and control 3 proves the guard can see a
 * violation by planting one.
 */
const EXPECTED_INLINE_BRAND_CASTS: Record<string, number> = {
  "electron/services/db/core/sqlText.ts": 2,
};

/**
 * Calls to `unsafeSql` that are NOT escapes: control 5 exercises it in order to
 * prove it is a runtime no-op (same reference back, composition by concatenation,
 * cooked-string identity). They stand in for no un-migrated statement; they ARE the
 * subject under test.
 *
 * They are LISTED rather than filtered out of the corpus. An exclusion rule is a
 * place for an escape to hide, and this guard's only real product is that the
 * measured map is complete — so the corpus stays whole, the categories are
 * separated here in the open, and the subtotal that matters (the 393 escapes) is
 * still asserted on its own below.
 */
const EXPECTED_CONTROL_CALLS: Record<string, number> = {
  "electron/services/db/core/__tests__/sqlText.runtimeIdentity.test.ts": 4,
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
  for (const root of SEARCH_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (fs.existsSync(abs)) walk(abs, found);
  }
  return found
    .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"))
    .filter((f) => f !== SELF && !f.startsWith(FIXTURE_DIR))
    .sort();
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

/** Escape call sites, matched as AST call expressions — never as text. */
function countEscapes(relPath: string, text: string): number {
  return countNodes(
    relPath,
    text,
    (node) =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "unsafeSql",
  );
}

/**
 * The rightmost identifier of an entity name: `SafeSql` for a bare reference, and
 * also for `sqlText.SafeSql`. A qualified name is the same assertion wearing a
 * namespace import.
 */
function rightmostName(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

/**
 * Does this type node NAME the brand, at any depth an assertion can wrap it in?
 *
 * Recursive on purpose. BACKLOG-3067's first matcher tested
 * `ts.isTypeReferenceNode(node.type)` directly, so parentheses, a union and a
 * namespace qualifier all slipped past — each a wrapper the matcher did not descend
 * through, not a different kind of escape. The fix both times was to resolve THROUGH
 * the wrappers, never to enumerate spellings: an enumeration is only ever as long as
 * the last person's imagination.
 */
function namesTheBrand(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isParenthesizedTypeNode(type)) return namesTheBrand(type.type);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some(namesTheBrand);
  }
  if (ts.isArrayTypeNode(type)) return namesTheBrand(type.elementType);
  if (ts.isTypeReferenceNode(type)) return rightmostName(type.typeName) === "SafeSql";
  return false;
}

/**
 * Inline type assertions claiming a value is branded, in BOTH of TypeScript's
 * assertion syntaxes: `expr as T` (`AsExpression`) and `<T>expr`
 * (`TypeAssertionExpression`).
 *
 * `<T>expr` is unavailable in `.tsx` — TypeScript parses it as JSX — and that is
 * handled for free rather than special-cased: `ts.createSourceFile` derives the
 * script kind from the file name, so a `.tsx` file cannot produce a
 * `TypeAssertionExpression` at all.
 */
function countInlineBrandCasts(relPath: string, text: string): number {
  return countNodes(
    relPath,
    text,
    (node) =>
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && namesTheBrand(node.type),
  );
}

function measure(counter: (relPath: string, text: string) => number): Record<string, number> {
  const measured: Record<string, number> = {};
  for (const relPath of sourceFiles()) {
    const n = counter(relPath, fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
    if (n > 0) measured[relPath] = n;
  }
  return measured;
}

const expectedCounts = Object.fromEntries(
  Object.entries(EXPECTED_ESCAPES).map(([file, entry]) => [file, entry.count]),
);
const EXPECTED_TOTAL = Object.values(EXPECTED_ESCAPES).reduce((a, e) => a + e.count, 0);

describe("BACKLOG-3064 — the escape set is exactly what the PR says it is", () => {
  it("finds a corpus to search (a guard over zero files always passes)", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(BRAND_MODULE);
    expect(files).toContain("electron/services/db/contactDbService.ts");
    expect(files).toContain("electron/services/reviewStateService.ts");
  });

  /**
   * THE RATCHET. Exact map, no threshold, no default owner. The number may only
   * fall, and it falls by an item MOVING a statement into the layer (BACKLOG-3044)
   * or REWRITING one with the tag (Phase B) — never by editing this map alone,
   * because the map is compared against a measurement.
   */
  it("has exactly the pre-registered escapes, file by file — nothing filtered", () => {
    // The WHOLE measured map, with nothing excluded from the corpus: the 393
    // migration escapes plus the 4 calls control 5 makes on purpose.
    expect(measure(countEscapes)).toEqual({ ...expectedCounts, ...EXPECTED_CONTROL_CALLS });
  });

  it("totals 30 ESCAPES in 5 files — 105 removed from outside the layer by BACKLOG-3044", () => {
    const measured = measure(countEscapes);
    const escapes = Object.fromEntries(
      Object.entries(measured).filter(([f]) => !(f in EXPECTED_CONTROL_CALLS)),
    );

    expect(escapes).toEqual(expectedCounts);
    expect(Object.values(escapes).reduce((a, b) => a + b, 0)).toBe(EXPECTED_TOTAL);
    expect(EXPECTED_TOTAL).toBe(30);
    expect(Object.keys(escapes)).toHaveLength(5);
  });

  /** Every escape carries an owner. No default, no fall-through, no blanks. */
  it("names an owner for every file holding an escape", () => {
    for (const [file, entry] of Object.entries(EXPECTED_ESCAPES)) {
      expect([file, entry.owner]).toEqual([file, expect.stringMatching(/^BACKLOG-\d+$/)]);
    }
    // The two owners mean different work, so the split is asserted rather than
    // left to be read off the table.
    const byOwner: Record<string, number> = {};
    for (const entry of Object.values(EXPECTED_ESCAPES)) {
      byOwner[entry.owner] = (byOwner[entry.owner] ?? 0) + entry.count;
    }
    expect(byOwner).toEqual({ "BACKLOG-3044": 26, "BACKLOG-3102": 4 });
  });

  /**
   * The matcher has to be able to tell a CALL from a MENTION, or every number above
   * is noise. `sqlText.ts` names `unsafeSql` repeatedly in its own prose and
   * declares it once — and calls it never.
   */
  it("counts calls, not mentions of them", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, BRAND_MODULE), "utf8");
    // The text says it more often than the program does. That gap is the whole
    // reason this is an AST match: a grep would report the larger number.
    const mentions = (text.match(/unsafeSql/g) ?? []).length;
    expect(mentions).toBeGreaterThan(countEscapes(BRAND_MODULE, text));
    expect(countEscapes(BRAND_MODULE, text)).toBe(0);

    // And the converse, on a file that really does call it: the control file's
    // calls are counted, and its prose about them is not.
    const controlFile = "electron/services/db/core/__tests__/sqlText.runtimeIdentity.test.ts";
    const controlText = fs.readFileSync(path.join(REPO_ROOT, controlFile), "utf8");
    expect((controlText.match(/unsafeSql/g) ?? []).length).toBeGreaterThan(
      countEscapes(controlFile, controlText),
    );
    expect(countEscapes(controlFile, controlText)).toBe(4);
  });

  /**
   * CONTROL 3 — the tag is the only sanctioned producer.
   *
   * A cast that names `SafeSql` mints the brand with no verification at all, which
   * is the one thing that would make the whole item decorative. Outside the brand
   * module the expected count is ZERO, and control 3 in the PR plants one in three
   * different files and three different syntaxes to prove this assertion can see
   * them.
   */
  it("names the brand in a cast ONLY inside the module that defines it", () => {
    const measured = measure(countInlineBrandCasts);
    expect(measured).toEqual(EXPECTED_INLINE_BRAND_CASTS);
    expect(Object.keys(measured)).toEqual([BRAND_MODULE]);
  });

  /**
   * The brand module's exports are the entire producible surface. If a fourth
   * export appears — a `castToSql`, a re-exported symbol, a helper that returns
   * `SafeSql` — the surface has grown and someone has to say so here.
   */
  it("exports exactly the tag and the counted escape", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, BRAND_MODULE), "utf8");
    const source = ts.createSourceFile(BRAND_MODULE, text, ts.ScriptTarget.ES2020, true);

    const exported: string[] = [];
    ts.forEachChild(source, (node) => {
      const isExported = ts.canHaveModifiers(node)
        ? ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        : false;
      if (!isExported) return;
      if (ts.isFunctionDeclaration(node) && node.name) exported.push(node.name.text);
      if (ts.isTypeAliasDeclaration(node)) exported.push(node.name.text);
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) exported.push(d.name.text);
        }
      }
    });

    expect(exported.sort()).toEqual(["SafeSql", "sql", "unsafeSql"]);
  });

  /**
   * The brand carrier must NOT be exported. That is what stops a caller
   * re-declaring `SafeSql` structurally in their own file and minting brands
   * without ever naming the type this suite watches for.
   */
  it("does not export the unique symbol that carries the brand", () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, BRAND_MODULE), "utf8");
    expect(text).toContain("declare const SqlBrand: unique symbol");
    expect(text).not.toMatch(/export\s+declare\s+const\s+SqlBrand/);
    expect(text).not.toMatch(/export\s*\{[^}]*\bSqlBrand\b/);
  });
});
