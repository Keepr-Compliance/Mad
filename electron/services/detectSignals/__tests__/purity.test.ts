/**
 * BACKLOG-4257 C7 — detectSignals/* and the quote-stripping module reach no
 * database, logger, Electron or file-system module, transitively.
 *
 * Walks the real import graph from the source files (parsed with the
 * TypeScript compiler, so comments and strings are not read as imports):
 * every relative specifier is resolved and followed; every bare specifier is
 * collected. Type-only imports are erased at runtime and are not followed.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const ELECTRON_DIR = path.resolve(__dirname, "../../..");
const SIGNALS_DIR = path.resolve(__dirname, "..");
const ROOTS = [
  ...fs
    .readdirSync(SIGNALS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(SIGNALS_DIR, f)),
  path.join(ELECTRON_DIR, "utils/quoteStripping.ts"),
];

/** Node builtins the graph may use (emailAddress.ts hashes with crypto). */
const ALLOWED_BARE = new Set(["crypto"]);
const FORBIDDEN_PATH = /[\\/](db|database)[\\/]|logService|dbConnection|[\\/]handlers[\\/]/;

/** Runtime module specifiers of one file: imports / re-exports that are not type-only, require(), import(). */
function runtimeSpecifiers(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            !!clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function resolveRelative(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec);
  for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), base]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  throw new Error(`unresolved import ${spec} from ${from}`);
}

function walk(): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const queue = [...ROOTS];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const spec of runtimeSpecifiers(file, src)) {
      if (spec.startsWith(".")) queue.push(resolveRelative(file, spec));
      else bare.add(spec);
    }
  }
  return { files, bare };
}

describe("C7 — purity of detectSignals and quoteStripping", () => {
  const { files, bare } = walk();

  it("walked the graph (anti-vacuity)", () => {
    const rel = [...files].map((f) => path.relative(ELECTRON_DIR, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        "services/detectSignals/extractSignals.ts",
        "utils/quoteStripping.ts",
        "utils/htmlToPlainText.ts",
        "services/transactionExtractorService.ts",
        "services/formRecognition/formMatcher.ts",
      ]),
    );
  });

  it("reaches no database, logger or handler module", () => {
    const bad = [...files].map((f) => path.relative(ELECTRON_DIR, f)).filter((f) => FORBIDDEN_PATH.test(f));
    expect(bad).toEqual([]);
  });

  it("imports no package other than the allowed builtins (no electron, no fs)", () => {
    expect([...bare].filter((b) => !ALLOWED_BARE.has(b))).toEqual([]);
  });
});
