/**
 * @jest-environment node
 *
 * BACKLOG-2673 — NO USER-FACING TEMPLATE COMPOSES A BARE ARTICLE WITH AN
 * INTERPOLATED VALUE.
 *
 * ---------------------------------------------------------------------------
 * WHY A RULE AND NOT AN ASSERTION
 * ---------------------------------------------------------------------------
 * The founder found *"Your Mac address book has **a** Ingrid Halvorsen"* at
 * gate 4. Fixing that one string fixes that one string. The defect is a SHAPE —
 * `` `a ${x}` `` — and the same shape was live in a second file at the same time
 * (`contactLinkReview.clusterQuestion`, which produced "a iPhone entry", "a
 * Outlook contacts entry" and "a Android phone entry" for three of the five
 * labels it can be handed). Both were written by people who checked the
 * sentence against the values they had in mind.
 *
 * So this file enforces the shape, not the strings. It is the assertion that
 * stops the next person reintroducing it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCAN IS AST-BASED AND NOT A GREP
 * ---------------------------------------------------------------------------
 * A grep for `"a "` finds the templates someone remembered, and it also finds
 * every prose comment, every identifier, and the word "a" inside unrelated
 * strings. This walks the TypeScript AST, so what it inspects is exactly the
 * text a template literal, a string concatenation or a JSX text node places
 * immediately before an interpolated value — and comments are invisible to it
 * by construction, which matters because the fix for BACKLOG-2673 documents the
 * broken template verbatim inside a comment.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A POSITIVE CONTROL IN THE FILE
 * ---------------------------------------------------------------------------
 * A scanner whose regex or traversal quietly stops matching passes forever and
 * says nothing — the exact failure mode BACKLOG-2439 records three times in one
 * night. `detects the defect it was written for` runs the detector over the
 * ORIGINAL broken source of both fixed sites and requires it to fire. If that
 * test ever goes green-by-vacuum, the whole file is worthless and it says so.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ROOTS = ["src", "electron"];

/**
 * Directories with no user-facing copy in them. `__tests__` is excluded because
 * a test asserting the OLD broken string is evidence, not a defect.
 */
const SKIP_DIRS = new Set(["node_modules", "__tests__", "__mocks__", "dist", "dist-electron", "build", "coverage"]);

/** Repo-relative, forward-slashed — `path.relative` yields backslashes on Windows CI. */
const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join("/");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      sourceFiles(path.join(dir, entry.name), acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

/**
 * The literal text sitting immediately before an interpolation, ending in a
 * bare indefinite article.
 *
 * Anchored at the end, because that is the only position that matters: `"a"`
 * in the middle of a sentence is followed by more words, not by the value.
 * The leading class stops `Rota ${x}` and `pizza ${x}` from matching.
 */
const ENDS_WITH_ARTICLE = /(^|[\s("'>[—–-])(a|an|A|An)\s+$/;

/** Same rule for JSX text, where trailing whitespace carries a newline + indent. */
const JSX_ENDS_WITH_ARTICLE = /(^|[\s("'>[—–-])(a|an|A|An)\s+$/;

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

/**
 * Log lines are not copy.
 *
 * Excluded BY CONSTRUCTION — by asking the AST what call encloses the string —
 * rather than by listing the five `electron/services/*` lines that happen to
 * exist today. A sixth added tomorrow is excluded for the same reason, and a
 * template moved OUT of a log call into a dialog is caught for the same reason.
 */
const LOGGER_CALLEE = /(^|\.)(console|logger|logService|electronLog|log)$|(^|\.)(console|logger|logService|electronLog)\.\w+$/;

function insideLoggerCall(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf).trim();
      if (LOGGER_CALLEE.test(callee)) return true;
    }
  }
  return false;
}

export function findArticleBeforeInterpolation(fileName: string, text: string): Finding[] {
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: Finding[] = [];

  const record = (node: ts.Node, snippet: string) => {
    if (insideLoggerCall(node, sf)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file: fileName, line: line + 1, snippet });
  };

  const visit = (node: ts.Node): void => {
    // 1. Template literals: the text before each `${...}`.
    if (ts.isTemplateExpression(node)) {
      const spans = node.templateSpans;
      const preceding = [node.head.text, ...spans.slice(0, -1).map((s) => s.literal.text)];
      preceding.forEach((before, i) => {
        if (ENDS_WITH_ARTICLE.test(before)) {
          record(node, `\`...${before.slice(-24)}\${${spans[i].expression.getText(sf)}}\``);
        }
      });
    }

    // 2. Concatenation: "…a " + value, including the middle of a longer chain.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = node.left;
      const literal = ts.isStringLiteral(left)
        ? left
        : ts.isBinaryExpression(left) &&
            left.operatorToken.kind === ts.SyntaxKind.PlusToken &&
            ts.isStringLiteral(left.right)
          ? left.right
          : null;
      if (literal && ENDS_WITH_ARTICLE.test(literal.text) && !ts.isStringLiteral(node.right)) {
        record(node, `"...${literal.text.slice(-24)}" + ${node.right.getText(sf).slice(0, 40)}`);
      }
    }

    // 3. JSX text followed by an expression: `... a {name}`.
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      node.children.forEach((child, i) => {
        const next = node.children[i + 1];
        if (
          ts.isJsxText(child) &&
          next &&
          ts.isJsxExpression(next) &&
          JSX_ENDS_WITH_ARTICLE.test(child.text)
        ) {
          record(child, `${child.text.trim().slice(-24)} {${next.expression?.getText(sf) ?? ""}}`);
        }
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

/**
 * Cheap superset filter. Every shape the AST pass can report leaves one of
 * these byte sequences in the raw source, so a file matching none of them
 * cannot contain a finding — and the suite parses ~30 files instead of ~1,500.
 *
 * `filesScanned` below asserts the filter did not swallow the tree.
 */
const CANDIDATE = /\b[Aa]n?\s+(\$\{|\{)|["'][Aa]n?\s*["']\s*\+|\b[Aa]n?\s*$/m;

describe("BACKLOG-2673 — no user-facing template concatenates an article with an interpolated value", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(path.join(REPO_ROOT, r)));

  it("scans a real tree, not an empty one", () => {
    // A guard that walks zero files is the green-by-vacuum failure this whole
    // file exists to avoid. The floor is deliberately far below the real count.
    expect(files.length).toBeGreaterThan(300);
  });

  /**
   * THE POSITIVE CONTROL — the detector must fire on the source it was written
   * for. Both snippets are the ORIGINAL text of the two sites BACKLOG-2673
   * fixed, transcribed from git history, not invented.
   */
  it("detects the defect it was written for", () => {
    const original = [
      // src/components/contact/components/ReviewDuplicatesModal.tsx:598, pre-fix
      'const who = first.sourceName ? `a ${first.sourceName}` : "an entry";',
      // electron/services/contactLinkReview.ts:287, pre-fix
      "const q = first.sourceName ? `x` : `a ${first.sourceLabel} entry`;",
      // The concatenation shape, which neither site used but the rule covers.
      'const s = "Your address book has a " + name;',
      // The JSX shape.
      "const el = <p>Your address book has a {name} in it.</p>;",
    ].join("\n");

    const found = findArticleBeforeInterpolation("control.tsx", original);
    expect(found.map((f) => f.line).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  /**
   * THE NEGATIVE CONTROL — the detector must NOT fire on the shapes the rewrite
   * uses, or the rule would forbid the fix. An article bound to a hardcoded
   * noun is correct and must stay legal.
   */
  it("does not fire on an article bound to a word the code owns", () => {
    const fixed = [
      "const a1 = `${subject} in your ${label} has the same phone number as this contact.`;",
      "const a2 = `an entry in your ${label}`;",
      "const a3 = `A record in your ${label} carries ${ident}.`;",
      "const a4 = `this ${label} entry`;",
      "const a5 = `Rota ${name}`;", // "a" as the tail of another word
      "const a6 = logger.info(`a ${sourceType} source was unlinked`);",
    ].join("\n");

    expect(findArticleBeforeInterpolation("control.ts", fixed)).toEqual([]);
  });

  it("finds no article before an interpolated value anywhere in src/ or electron/", () => {
    const findings: Finding[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      if (!CANDIDATE.test(text)) continue;
      findings.push(
        ...findArticleBeforeInterpolation(file, text).map((f) => ({ ...f, file: rel(f.file) })),
      );
    }

    // Named, so a failure prints the offending sentence rather than a count.
    expect(findings.map((f) => `${f.file}:${f.line}  ${f.snippet}`)).toEqual([]);
  });
});
