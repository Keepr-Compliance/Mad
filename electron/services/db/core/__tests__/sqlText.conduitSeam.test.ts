/**
 * BACKLOG-3086 — the two seams a name matcher cannot watch.
 *
 * ## Why this is a second guard and not four more patterns in the first one
 *
 * `sqlText.escapeSet.test.ts` counts assertions that NAME `SafeSql`. That is the
 * right instrument for what it watches, and it is not changed here. But the
 * property this epic actually needs is different:
 *
 *     "can a value of unbranded type reach a conduit parameter?"
 *
 * and it is **not** answerable at the call site — because at the call site it is
 * already answered. `dbAll(handWritten)` is TS2345 today; the compiler holds that
 * line without help. Every laundering route therefore mints its lie somewhere ELSE,
 * and there turn out to be exactly two such places.
 *
 * **SEAM A — the conduit function VALUE escapes callee position.** The moment
 * `dbAll` is a value rather than a callee, it can be retyped: by assertion, by
 * method-syntax bivariance, or by reflection. Nothing in any of those routes names
 * the brand, in any spelling, so no matcher over assertion nodes can see them by
 * construction.
 *
 * **SEAM B — a declaration outside the brand module states `SafeSql` as an output
 * type that the compiler never checks against a body.** An overload signature, an
 * ambient declaration and a type predicate all state a return type TypeScript takes
 * on trust.
 *
 * ## The list of unchecked positions is closed by the LANGUAGE, not by imagination
 *
 * That distinction is what makes Seam B a property and not another enumeration.
 * Measured, one `tsc` project per probe, under the real settings:
 *
 *     interface Maker { make(s: string): SafeSql }   with a CHECKED impl -> TS2322 REJECTED
 *     class C implements Maker { make(s: string): string }               -> TS2416 REJECTED
 *     function launder(s: string): SafeSql;          overload, no body   -> exit 0 LAUNDERS
 *     declare function launder(s: string): SafeSql;  ambient, no body    -> exit 0 LAUNDERS
 *     function isSql(s: string): s is SafeSql        predicate, unchecked-> exit 0 LAUNDERS
 *
 * The class row is the stronger half and was missing from the first version of this
 * paragraph. RETURN position stays COVARIANT even under method syntax — method
 * bivariance is a rule about PARAMETERS — so a class implementing the interface with a
 * `string` return is refused as well, not just an object literal. The interface is not
 * the hole; an AMBIENT declaration of one is, because then there is no implementation
 * anywhere for the compiler to check.
 *
 * An implementation the compiler actually checks CANNOT lie. So a legitimate Phase B
 * fragment helper — `function activeClause(): SafeSql { return sql`...`; }`, which has
 * a body — never fires here, and the registry below stays empty as the migration
 * proceeds. That is deliberate: a guard that fires on the correct path gets deleted.
 *
 * ## Why the CHECKER, and why that is not re-claiming BACKLOG-3072's territory
 *
 * BACKLOG-3072 records that `namesABrand()` compares a NAME against a set and that
 * TypeScript can name one type in unboundedly many ways. That limit is real and it
 * is exactly why this guard does not match names at all:
 *
 *   - conduit verbs are resolved to SYMBOLS (`getExportsOfModule`, then
 *     `getAliasedSymbol` at each use), so `import { dbAll as q }` and the
 *     `electron/services/db/index.ts` re-export chain are the same symbol —
 *     `A6_importAlias.ts` and `A8_barrelNamedImport.ts` are those two cases, and
 *     both were written because the claim was made before it was tested;
 *   - modules are resolved the same way, by what they EXPORT rather than by path,
 *     so the barrel is not a way around the namespace ban (`A7_barrelNamespace.ts`);
 *   - the brand is resolved to the PROPERTY SYMBOL declared in `sqlText.ts`, so an
 *     import alias behind a type alias resolves to it. `B4_aliasedOverload.ts` is
 *     that case, kept live below.
 *
 * This guard therefore implements 3072's prescribed fix inside its own scope. It
 * does not fix 3072 — `sqlText.escapeSet.test.ts` still matches names, and still
 * has the limit 3072 owns.
 *
 * ## WHAT THIS COVERS
 *
 *   Seam A  a conduit verb (`dbGet`/`dbAll`/`dbRun`/`dbExec`) referenced anywhere
 *           other than callee position — asserted, assigned, passed, aliased,
 *           spread into a bivariant method slot, or erased to `Function`
 *   Seam A(ii)  a NAMESPACE or DYNAMIC import of any module that hands out a conduit
 *           verb — resolved by asking the module what it exports, so the
 *           `electron/services/db` barrel is covered as well as `dbConnection.ts`
 *           itself, and so is a barrel added later. The namespace object routes
 *           around the symbol walk (a destructuring annotation retypes the binding,
 *           and the identifier's symbol is then the ANNOTATION's member, not the
 *           export), so this ban is what makes the symbol walk sufficient rather
 *           than merely suggestive. Named re-exports are RECORDED, not banned: a
 *           named re-export cannot widen a signature.
 *   Seam B  outside `sqlText.ts`, an output type carrying the brand on a bodiless
 *           FUNCTION / METHOD / CONSTRUCTOR / ACCESSOR declaration, an ambient
 *           variable or property declaration, or a type predicate — resolved by
 *           type identity, and reached along every axis a type holds another type on:
 *           union and intersection constituents, type arguments, CALL and CONSTRUCT
 *           SIGNATURE RETURNS, INDEX INFOS (which is also what a mapped type over an
 *           open key set resolves to), and properties.
 *
 * ## WHAT THIS DOES NOT COVER — stated, with an owner for each
 *
 *   - **`@ts-expect-error` / `@ts-ignore` above a conduit call.** Measured: compiles,
 *     exit 0. It avoids both seams and names nothing. `@typescript-eslint/ban-ts-comment`
 *     is `warn` in `eslint.config.js` and therefore blocks nothing — the same shape,
 *     and the same reason, as **BACKLOG-3073**, which owns the `any` route.
 *   - **`require(".../dbConnection")`** yields `any`. **BACKLOG-3073.**
 *   - **Casts that name the brand.** Counted by `sqlText.escapeSet.test.ts`, whose
 *     name-set limit is **BACKLOG-3072**.
 *   - **An assertion whose TARGET merely contains the brand.** Measured, compiles:
 *
 *         interface Maker { make(s: string): SafeSql }
 *         const m = { make: (s: string) => s } as Maker;   // exit 0
 *         dbAll(m.make(hw), []);
 *
 *     `as Maker` names no brand, so the ratchet is blind; `MethodSignature` is not an
 *     unchecked-output position (an object literal ANNOTATED `: Maker` is refused —
 *     TS2322 — which is why it is absent from Seam B), so this guard is blind too.
 *     Closing it needs the assertion TARGET resolved through the checker and
 *     descended into its call signatures — which is **BACKLOG-3072's** stated fix
 *     shape, one level deeper. **3072 owns it.**
 *   - **The corpus is `tsconfig.electron.json`**, which excludes every `.test.ts`
 *     file, `electron/preload`, and everything outside `electron/`. Verified by grep that
 *     no file under `src/` or `scripts/` imports the conduit. Test files DO hold the
 *     conduit in value position — `jest.MockedFunction<typeof dbAll>`,
 *     `import * as dbConnection` — which is legitimate mocking, and is out of corpus
 *     on purpose rather than by oversight. **This item owns that residue.**
 *   - **A brand in a PARAMETER of a bodiless declaration.** Measured, compiles:
 *
 *         declare function withSql(cb: (s: SafeSql) => void): void;
 *         withSql((s) => { dbAll(s, []); });        // `s` is branded, unproven
 *
 *     Only OUTPUT positions are visited, and this is an input one — a question about
 *     VARIANCE, not about depth or axes, and deliberately out of this item's scope.
 *     **It is UNOWNED. No item covers it today**, and it is written here rather than
 *     left for the next reader to rediscover.
 *   - **`carriesBrand()` descends to a bounded DEPTH of 4.** Note what this sentence
 *     does and does not say. An earlier version disclosed a depth limit and nothing
 *     else, while three whole AXES went unvisited — call-signature returns, index
 *     infos, and mapped members — so `declare const m: Maker`,
 *     `declare const bag: { [k: string]: SafeSql }` and
 *     `declare const t: Record<string, SafeSql>` all walked past a guard whose header
 *     said only "bounded depth". **Depth and axes are different failures, and
 *     disclosing one does not cover the other.** The axes are now closed; what is
 *     bounded is genuinely only depth. **This item owns the depth bound.**
 *   - **`getRawDatabase()`** hands out the raw driver handle and bypasses the module
 *     entirely. Phase B, as `sqlText.ts` already says.
 *
 * ## The fixtures are the non-vacuity control, and they run every time
 *
 * `electron/types/__typefixtures__/conduitSeam/` holds EIGHTEEN live launders and one must-not-fire control. They are
 * added to this guard's program and each one is asserted DETECTED, by file, by seam.
 * A planted control proves the guard worked on the day someone planted it; these
 * prove it on every CI run. The same directory is compiled by `tsconfig.all.json` and
 * asserted to produce ZERO diagnostics — because "these are legal TypeScript" is the
 * defect claim, and a claim nobody re-measures is a claim that quietly expires.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const TSCONFIG = path.join(REPO_ROOT, "tsconfig.electron.json");

const CONDUIT_MODULE = "electron/services/db/core/dbConnection.ts";
const BRAND_MODULE = "electron/services/db/core/sqlText.ts";
const FIXTURE_DIR = "electron/types/__typefixtures__/conduitSeam";

/** The four verbs whose first parameter is the brand. `dbTransaction` takes no SQL. */
const CONDUIT_VERBS = ["dbGet", "dbAll", "dbRun", "dbExec"] as const;

/**
 * PRE-REGISTERED — measured on the pristine tree at `1e05ce90b` BEFORE any
 * production edit, and posted to `pm_comments` on BACKLOG-3086 before this file was
 * written. Both seams measured EMPTY, which is the item's "neither shape exists in
 * the tree today" turned from a claim into a number.
 *
 * Empty is the whole point. If a row ever has to be added here, someone is holding
 * the conduit as a value or minting the brand from an unchecked declaration, and
 * they have to say why in the PR — which is the same contract as the escape map in
 * `sqlText.escapeSet.test.ts`, with no default owner and no fall-through.
 */
const EXPECTED_SEAM_A: Record<string, number> = {};
const EXPECTED_SEAM_B: Record<string, number> = {};

/**
 * The conduit's import surface. A NAMED re-export cannot widen a signature — the
 * symbol travels intact, and this guard resolves through it — so `db/index.ts` is
 * recorded rather than forbidden. A namespace import can, which is why the expected
 * set for it is the fixture and nothing else.
 */
const EXPECTED_REEXPORTS = ["electron/services/db/index.ts"];

/**
 * Every fixture, and the seam that must report it. Nothing here may go quiet.
 *
 * `"none"` is not a gap — it is the OTHER assertion. `OK1_bodiedFragmentHelper.ts` is
 * the legitimate Phase B shape and must stay invisible to both seams; a guard that
 * fires on the correct path gets switched off within a week, so must-not-fire is
 * asserted here on every run rather than remembered from one review.
 */
const EXPECTED_FIXTURE_DETECTION: Record<string, "A" | "A(ii)" | "B" | "none"> = {
  "A1_widenConduitCast.ts": "A",
  "A2_methodBivariance.ts": "A",
  "A3_reflectApply.ts": "A",
  "A4_functionType.ts": "A",
  "A5_namespaceImport.ts": "A(ii)",
  "A6_importAlias.ts": "A",
  "A7_barrelNamespace.ts": "A(ii)",
  "A8_barrelNamedImport.ts": "A",
  "B1_overloadLaunder.ts": "B",
  "B2_ambientDeclare.ts": "B",
  "B3_classMethodOverload.ts": "B",
  "B4_aliasedOverload.ts": "B",
  "B5_typePredicate.ts": "B",
  "B6_assertsPredicate.ts": "B",
  "B7_ambientConst.ts": "B",
  "B8_interfaceMethodReturn.ts": "B",
  "B9_indexSignature.ts": "B",
  "B10_mappedRecord.ts": "B",
  "OK1_bodiedFragmentHelper.ts": "none",
};

/** Building one program over the electron project measures ~5s. */
jest.setTimeout(300_000);

interface Seams {
  program: ts.Program;
  seamA: Record<string, number>;
  seamB: Record<string, number>;
  namespaceImports: string[];
  dynamicImports: string[];
  reExports: string[];
  conduitSymbolCount: number;
  brandPropName: string;
  fileCount: number;
}

let measured: Seams;

function relOf(file: ts.SourceFile): string {
  return path.relative(REPO_ROOT, file.fileName).split(path.sep).join("/");
}

function measureSeams(): Seams {
  const parsed = ts.getParsedCommandLineOfConfigFile(TSCONFIG, { noEmit: true }, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error(`could not read ${TSCONFIG}`);

  // The launder fixtures are excluded from every root tsconfig (they must never
  // reach `type-check` or `build:electron`), so they are added HERE explicitly.
  const fixtureAbs = fs
    .readdirSync(path.join(REPO_ROOT, FIXTURE_DIR))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(REPO_ROOT, FIXTURE_DIR, f));

  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, ...fixtureAbs],
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();

  const conduitFile = program.getSourceFiles().find((f) => relOf(f) === CONDUIT_MODULE);
  const brandFile = program.getSourceFiles().find((f) => relOf(f) === BRAND_MODULE);
  if (!conduitFile || !brandFile) throw new Error("conduit or brand module missing from program");

  // --- the four verbs, as SYMBOLS. Not as the strings "dbAll" etc. ---
  const conduitModuleSymbol = checker.getSymbolAtLocation(conduitFile);
  if (!conduitModuleSymbol) throw new Error("conduit module has no symbol");
  const conduitExports = checker.getExportsOfModule(conduitModuleSymbol);
  const conduitSymbols = new Set<ts.Symbol>();
  for (const verb of CONDUIT_VERBS) {
    const found = conduitExports.find((e) => e.name === verb);
    if (!found) throw new Error(`conduit verb not resolved: ${verb}`);
    conduitSymbols.add(found);
  }

  // --- the brand, as the PROPERTY SYMBOL declared in sqlText.ts ---
  const brandModuleSymbol = checker.getSymbolAtLocation(brandFile);
  if (!brandModuleSymbol) throw new Error("brand module has no symbol");
  const safeSqlSymbol = checker
    .getExportsOfModule(brandModuleSymbol)
    .find((e) => e.name === "SafeSql");
  if (!safeSqlSymbol) throw new Error("SafeSql not exported from the brand module");
  const safeSqlType = checker.getDeclaredTypeOfSymbol(safeSqlSymbol);
  // The one property of `SafeSql` that `string` does not have is the brand carrier:
  // it is the only member DECLARED in the brand module. Its printed name embeds an
  // unstable declaration id (`__@SqlBrand@39`), so it is derived, never written down.
  const brandProp = safeSqlType
    .getProperties()
    .find((p) => p.declarations?.some((d) => d.getSourceFile() === brandFile));
  if (!brandProp) throw new Error("brand carrier property not resolved from SafeSql");

  const MAX_DEPTH = 4;
  /**
   * Does this type carry the brand? Compared by SYMBOL IDENTITY against the property
   * declared in `sqlText.ts` — never by name, which is the whole reason this guard
   * exists rather than a longer pattern list.
   *
   * `checker.getPropertyOfType(type, brandProp.name)` looks like the obvious call and
   * is WRONG here: it runs the name through `escapeLeadingUnderscores`, which prepends
   * an underscore to anything starting with `__`, so the unique-symbol member
   * `__@SqlBrand@12` is looked up as `___@SqlBrand@12` and never found. That returned
   * a silent, permanent `false` — a detector that measured nothing and passed. The
   * launder fixtures caught it on their first run, which is exactly what they are for.
   *
   * ## The AXES, and why the depth limit never covered them
   *
   * A type holds other types along several axes, and this walk originally visited
   * only three: union/intersection constituents, type arguments, and properties. Three
   * shapes therefore walked past it, each of them a real mint:
   *
   *     declare const m: Maker                         // Maker.make RETURNS the brand
   *     declare const bag: { [k: string]: SafeSql }    // an INDEX signature
   *     declare const t: Record<string, SafeSql>       // a MAPPED type
   *
   * All three compiled and all three left the guard 9/9 green, with a positive control
   * in the same file going red — so the greens were readable, and the miss was real.
   *
   * The header used to disclose a *depth* limit and nothing else. **Depth and axes are
   * different failures**: no depth budget reaches a call-signature return if the walk
   * never asks a type for its call signatures. Disclosing the first does not cover the
   * second, and saying "bounded depth" while an entire axis went unvisited is the same
   * false-completeness shape this whole item exists to delete.
   *
   * So the fix is the axis, not the three examples: call and construct signature
   * RETURN types, and index infos (which is also what a mapped type over an open key
   * set resolves to). What remains bounded is now genuinely only depth.
   */
  const carriesBrand = (type: ts.Type, depth = 0, seen = new Set<ts.Type>()): boolean => {
    if (depth > MAX_DEPTH || seen.has(type)) return false;
    seen.add(type);
    if (type.getProperties().some((p) => p === brandProp)) return true;
    if (type.isUnionOrIntersection()) {
      return type.types.some((t) => carriesBrand(t, depth + 1, seen));
    }
    const objectFlags = (type as ts.ObjectType).objectFlags ?? 0;
    if (type.flags & ts.TypeFlags.Object && objectFlags & ts.ObjectFlags.Reference) {
      const args = checker.getTypeArguments(type as ts.TypeReference);
      if (args.some((t) => carriesBrand(t, depth + 1, seen))) return true;
    }
    // What a call RETURNS is an output position like any other, and `Maker.make` is
    // reached only through this axis: the property descent below lands on the function
    // type, whose own property list is empty.
    const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()];
    if (signatures.some((sig) => carriesBrand(sig.getReturnType(), depth + 1, seen))) {
      return true;
    }
    // Index signatures, and mapped types over an open key set — `Record<string, SafeSql>`
    // has no properties to descend, so without this it is invisible however deep the
    // walk goes.
    if (
      checker.getIndexInfosOfType(type).some((info) => carriesBrand(info.type, depth + 1, seen))
    ) {
      return true;
    }
    // One hop through members, for `(): { s: SafeSql }`. Object types only — walking
    // `string`'s method table would cost a great deal and can never find the brand.
    if (depth < MAX_DEPTH && type.flags & ts.TypeFlags.Object) {
      return type
        .getProperties()
        .some((p) => carriesBrand(checker.getTypeOfSymbol(p), depth + 1, seen));
    }
    return false;
  };

  // --- Seam A: is this identifier a conduit verb outside callee position? ---
  const isCalleePosition = (id: ts.Identifier): boolean => {
    const parent = id.parent;
    if (ts.isCallExpression(parent) && parent.expression === id) return true;
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
      const grand = parent.parent;
      if (ts.isCallExpression(grand) && grand.expression === parent) return true;
    }
    return false;
  };

  /**
   * Positions that reference no value: the import/export statement itself, `typeof
   * dbAll`, a qualified type name, and declaration names (a `{ dbAll: ... }` KEY is
   * not a use of the export). Namespace imports are not merely skipped here — they
   * are separately banned below, which is what closes the hole this skip opens.
   */
  const isNonValuePosition = (id: ts.Identifier): boolean => {
    const parent = id.parent;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isTypeQueryNode(parent) ||
      ts.isQualifiedName(parent) ||
      ts.isTypeReferenceNode(parent)
    ) {
      return true;
    }
    if (ts.isFunctionDeclaration(parent) && parent.name === id) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === id) return true;
    if (ts.isPropertySignature(parent) && parent.name === id) return true;
    if (ts.isMethodDeclaration(parent) && parent.name === id) return true;
    if (ts.isMethodSignature(parent) && parent.name === id) return true;
    return false;
  };

  const resolve = (id: ts.Identifier): ts.Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(id);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        /* an unresolvable alias is not a conduit symbol */
      }
    }
    return symbol;
  };

  /**
   * Does this module specifier lead to a module that HANDS OUT a conduit verb —
   * directly, or through any barrel that re-exports one?
   *
   * Resolved by symbol identity, and that is not a detail. The first version asked
   * `relOf(targetFile) === CONDUIT_MODULE`, which is a PATH match, and
   * `electron/services/db/index.ts` re-exports all four verbs — so
   * `import * as db from "../db"` walked straight past the namespace ban and handed
   * out exactly the object `A5_namespaceImport.ts` retypes. Measured: no production
   * file does it today, but the header's claim that banning the namespace import
   * makes the symbol walk sufficient was FALSE AS WRITTEN. Asking the module what it
   * exports closes every barrel that exists and every one added later, with one rule
   * instead of a list of paths. `A7_barrelNamespace.ts` keeps it honest.
   */
  const reachesConduitCache = new Map<ts.Symbol, boolean>();
  const reachesConduit = (spec: ts.StringLiteral): boolean => {
    const moduleSymbol = checker.getSymbolAtLocation(spec);
    if (!moduleSymbol) return false;
    const cached = reachesConduitCache.get(moduleSymbol);
    if (cached !== undefined) return cached;
    const hit = checker.getExportsOfModule(moduleSymbol).some((exported) => {
      const resolved =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      return conduitSymbols.has(resolved);
    });
    reachesConduitCache.set(moduleSymbol, hit);
    return hit;
  };

  /** Output positions TypeScript states but never checks against a body. */
  const uncheckedOutputType = (node: ts.Node): ts.TypeNode | undefined => {
    if (ts.isTypePredicateNode(node)) return node.type;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node)) &&
      !node.body
    ) {
      return node.type;
    }
    // `declare const x: SafeSql`. `getCombinedModifierFlags` is the PUBLIC route and
    // it walks up to the enclosing `declare module`, so a member of an ambient block
    // is caught without the block itself carrying the modifier. (`ts.NodeFlags.Ambient`
    // reads better and is INTERNAL — it is absent from `typescript.d.ts`, compiles
    // under jest, and takes `type-check:tests` red. Which is a CI step, not this one.)
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient
    ) {
      return node.type;
    }
    return undefined;
  };

  const seamA: Record<string, number> = {};
  const seamB: Record<string, number> = {};
  const namespaceImports: string[] = [];
  const dynamicImports: string[] = [];
  const reExports: string[] = [];
  let fileCount = 0;

  for (const file of program.getSourceFiles()) {
    const rel = relOf(file);
    if (rel.startsWith("..") || rel.startsWith("node_modules/")) continue;
    if (!file.isDeclarationFile) fileCount += 1;

    const visit = (node: ts.Node): void => {
      // Seam A — the conduit value escaping callee position.
      //
      // NOTE THE ABSENCE OF A NAME PRE-FILTER. The first version of this walk began
      // `CONDUIT_VERBS.includes(node.text)` as a cheap gate before resolving the
      // symbol — which made it a name matcher wearing a checker's clothes:
      // `import { dbAll as q }` then `q as (s: string) => unknown[]` was never
      // visited at all, and the guard stayed 9/9 green on a live launder. Measured,
      // then fixed. `A6_importAlias.ts` is that case, kept live so it cannot come
      // back. Every identifier in a value position is resolved; the position filters
      // below are what keep that affordable.
      if (
        rel !== CONDUIT_MODULE &&
        ts.isIdentifier(node) &&
        !isNonValuePosition(node) &&
        !isCalleePosition(node)
      ) {
        let symbol = resolve(node);
        if (ts.isShorthandPropertyAssignment(node.parent)) {
          const value = checker.getShorthandAssignmentValueSymbol(node.parent);
          if (value) {
            symbol =
              value.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value;
          }
        }
        if (symbol && conduitSymbols.has(symbol)) seamA[rel] = (seamA[rel] ?? 0) + 1;
      }

      // Seam B — an unchecked declaration minting the brand.
      if (rel !== BRAND_MODULE) {
        const typeNode = uncheckedOutputType(node);
        if (typeNode && carriesBrand(checker.getTypeFromTypeNode(typeNode))) {
          seamB[rel] = (seamB[rel] ?? 0) + 1;
        }
      }

      // Seam A(ii) — how the conduit module is reached.
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        if (spec && ts.isStringLiteral(spec)) {
          if (reachesConduit(spec)) {
            if (ts.isExportDeclaration(node)) reExports.push(rel);
            else if (
              node.importClause?.namedBindings &&
              ts.isNamespaceImport(node.importClause.namedBindings)
            ) {
              namespaceImports.push(rel);
            }
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        reachesConduit(node.arguments[0] as ts.StringLiteral)
      ) {
        dynamicImports.push(rel);
      }

      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }

  return {
    program,
    seamA,
    seamB,
    namespaceImports: [...new Set(namespaceImports)].sort(),
    dynamicImports: [...new Set(dynamicImports)].sort(),
    reExports: [...new Set(reExports)].sort(),
    conduitSymbolCount: conduitSymbols.size,
    brandPropName: brandProp.name,
    fileCount,
  };
}

const inFixtures = (rec: Record<string, number>): string[] =>
  Object.keys(rec)
    .filter((f) => f.startsWith(`${FIXTURE_DIR}/`))
    .map((f) => path.basename(f))
    .sort();

const outsideFixtures = (rec: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(rec).filter(([f]) => !f.startsWith(`${FIXTURE_DIR}/`)));

beforeAll(() => {
  measured = measureSeams();
});

describe("BACKLOG-3086 — the guard is measuring something", () => {
  /** A guard over an empty corpus, or with an unresolved symbol, passes vacuously. */
  it("built a real program and resolved the conduit and the brand by identity", () => {
    expect(measured.fileCount).toBeGreaterThan(300);
    expect(measured.conduitSymbolCount).toBe(CONDUIT_VERBS.length);
    // Derived, not written down: the printed name carries an unstable declaration id.
    expect(measured.brandPropName).toMatch(/SqlBrand/);
    const files = measured.program.getSourceFiles().map(relOf);
    expect(files).toContain(CONDUIT_MODULE);
    expect(files).toContain(BRAND_MODULE);
    expect(files).toContain(`${FIXTURE_DIR}/A1_widenConduitCast.ts`);
  });

  /**
   * The defect claim, kept live. Every fixture is legal TypeScript under the real
   * settings — that is why they launder. If a compiler upgrade or a stricter option
   * makes one illegal, this goes red and that fixture can be retired ON EVIDENCE.
   */
  it("compiles all nineteen fixtures with zero diagnostics — they really are legal", () => {
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("typescript/lib/tsc.js"),
        "-p",
        path.join(REPO_ROOT, FIXTURE_DIR, "tsconfig.all.json"),
      ],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect([result.status, output.trim()]).toEqual([0, ""]);
  });
});

describe("BACKLOG-3086 — Seam A: the conduit value never leaves callee position", () => {
  it("has exactly the pre-registered value-position references (none)", () => {
    expect(outsideFixtures(measured.seamA)).toEqual(EXPECTED_SEAM_A);
  });

  /**
   * NON-VACUITY, on every run. Four laundering shapes, none of which names the brand
   * anywhere: an assertion on the function, a bivariant method slot, reflection, and
   * erasure to `Function`.
   */
  it("detects every Seam A launder fixture", () => {
    const expected = Object.entries(EXPECTED_FIXTURE_DETECTION)
      .filter(([, seam]) => seam === "A")
      .map(([file]) => file)
      .sort();
    // A5 reaches the conduit through the namespace object; Seam A(ii) owns it, and
    // whether the symbol walk ALSO sees it is not asserted here on purpose — the ban
    // is the thing that must hold.
    const ownedByTheBan = new Set(["A5_namespaceImport.ts", "A7_barrelNamespace.ts"]);
    expect(
      inFixtures(measured.seamA).filter((f) => f.startsWith("A") && !ownedByTheBan.has(f)),
    ).toEqual(expected);
  });

  it("is reached only by named import — no namespace import, no dynamic import", () => {
    expect(measured.namespaceImports).toEqual([
      `${FIXTURE_DIR}/A5_namespaceImport.ts`,
      `${FIXTURE_DIR}/A7_barrelNamespace.ts`,
    ]);
    expect(measured.dynamicImports).toEqual([]);
    expect(measured.reExports).toEqual(EXPECTED_REEXPORTS);
  });
});

describe("BACKLOG-3086 — Seam B: nothing outside the brand module mints it unchecked", () => {
  it("has exactly the pre-registered unchecked declarations (none)", () => {
    expect(outsideFixtures(measured.seamB)).toEqual(EXPECTED_SEAM_B);
  });

  /**
   * NON-VACUITY, on every run. Six shapes: a function overload, an ambient
   * declaration, a class method overload, an overload reached through an import
   * alias behind a type alias, a type predicate and an assertion predicate.
   *
   * `B4_aliasedOverload.ts` is the one that would survive a rewrite back to a name
   * set — the string "SafeSql" appears nowhere in it. It is the assertion proving
   * this guard resolves identity and not spelling.
   */
  it("detects every Seam B launder fixture", () => {
    const expected = Object.entries(EXPECTED_FIXTURE_DETECTION)
      .filter(([, seam]) => seam === "B")
      .map(([file]) => file)
      .sort();
    expect(inFixtures(measured.seamB)).toEqual(expected);
  });
});

describe("BACKLOG-3086 — the fixture corpus is what the guard says it is", () => {
  /** A fixture deleted or renamed silently reduces what is proven. It fails here. */
  it("contains exactly the registered launder fixtures", () => {
    const onDisk = fs
      .readdirSync(path.join(REPO_ROOT, FIXTURE_DIR))
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(onDisk).toEqual(Object.keys(EXPECTED_FIXTURE_DETECTION).sort());
    expect(onDisk).toHaveLength(19);
  });

  /** Every LAUNDER is detected by some seam. None may go quiet. */
  it("leaves no launder fixture undetected", () => {
    const detected = new Set([
      ...inFixtures(measured.seamA),
      ...inFixtures(measured.seamB),
      ...measured.namespaceImports.map((f) => path.basename(f)),
    ]);
    const launders = Object.entries(EXPECTED_FIXTURE_DETECTION)
      .filter(([, seam]) => seam !== "none")
      .map(([file]) => file)
      .sort();
    expect([...detected].sort()).toEqual(launders);
  });

  /**
   * MUST NOT FIRE. The legitimate Phase B shape — a bodied fragment helper composed
   * with the tag and handed to a conduit verb — is invisible to both seams. If this
   * ever goes red the guard has started taxing correct code, and that is the failure
   * that gets a guard deleted rather than fixed.
   */
  it("does not fire on the legitimate bodied-producer path", () => {
    const silent = Object.entries(EXPECTED_FIXTURE_DETECTION)
      .filter(([, seam]) => seam === "none")
      .map(([file]) => file);
    expect(silent).toHaveLength(1);
    for (const file of silent) {
      expect(inFixtures(measured.seamA)).not.toContain(file);
      expect(inFixtures(measured.seamB)).not.toContain(file);
      expect(measured.namespaceImports.map((f) => path.basename(f))).not.toContain(file);
    }
  });
});
