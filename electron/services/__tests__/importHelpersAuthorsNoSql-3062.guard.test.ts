/**
 * `importHelpers.ts` authors no SQL — BACKLOG-3062.
 *
 * ## Why this guard is AST-based and not lexical
 *
 * The obvious control — "a template containing SQL keywords and an interpolation
 * must go red" — was specified and then WITHDRAWN, because it has a
 * counter-example that cannot be regexed away:
 *
 *     `AND message.date > ${cutoffNano}`      <- a defect
 *     `${a} and ${b} were updated`            <- prose
 *
 * No lexical matcher separates those, and a check that cannot tell them apart
 * either misses the defect or fires on prose and gets switched off within a
 * week. The property is not lexical.
 *
 * What IS decidable is the shape of the node. This walks the AST and asks, of
 * every template literal with a substitution, whether its STATIC halves parse as
 * SQL — a statement keyword, or a column-qualified comparison. That is the pass
 * that found six SQL-producing templates in this file where a line-oriented
 * matcher reported four.
 *
 * ## This is a floor, not a proof
 *
 * A file could still author SQL by concatenation through three variables, or by
 * returning a string built somewhere else. The durable fix is BACKLOG-3064 — a
 * branded SQL value that only `db/` can mint, which makes the property a
 * compile-time one instead of a heuristic. This guard holds the line until then,
 * and its limit is stated rather than implied.
 */

import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TARGET = path.join(
  REPO_ROOT,
  "electron",
  "services",
  "macOSMessagesImportService",
  "importHelpers.ts",
);

/**
 * Two signals, and BOTH are deliberately narrow.
 *
 * `STATEMENT` is CASE-SENSITIVE and uppercase. My first attempt matched
 * case-insensitively and immediately fired on the prose fixture below —
 * `Imported ${n} messages from ${source} where ${who} selected them` contains
 * "from" and "where". That is the exact noise failure this item predicts, and
 * the false-positive precondition caught it before the guard ever ran on real
 * source.
 *
 * STATED LIMIT: a template writing SQL in lowercase would be missed. Every SQL
 * string in this repository is uppercase-keyworded, so the rule matches the
 * convention rather than hoping — but it IS a convention, not a proof, which is
 * one more reason the durable answer is BACKLOG-3064's branded value.
 *
 * `QUALIFIED_COMPARISON` is structural, not lexical: `message.date >` is a
 * dotted identifier in an operator position. Prose does not take that shape, and
 * it is what catches `AND message.date > ${n}` — the defect a keyword list
 * misses entirely.
 */
const STATEMENT = /\b(SELECT|INSERT\s+INTO|UPDATE\s+[a-z_"]|DELETE\s+FROM|FROM\s+[a-z_"]|WHERE\s|JOIN\s|VALUES\s*\(|CREATE\s+TABLE|CREATE\s+INDEX|DROP\s+TABLE|UNION\s+ALL|GROUP\s+BY|ORDER\s+BY)\b/;
const QUALIFIED_COMPARISON = /\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\s*(=|<>|!=|<=|>=|<|>|IS\s+(NOT\s+)?NULL|IN\s*\(|LIKE\s)/i;

interface Found {
  line: number;
  statics: string;
  splices: string[];
  reason: string;
}

/** Every interpolating template whose static text reads as SQL. */
export function sqlProducingTemplates(source: string, fileName = "x.ts"): Found[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: Found[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isTemplateExpression(n)) {
      const statics = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ");
      const reason = STATEMENT.test(statics)
        ? "statement keyword"
        : QUALIFIED_COMPARISON.test(statics)
          ? "qualified-column comparison"
          : "";
      if (reason) {
        out.push({
          line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
          statics: statics.replace(/\s+/g, " ").trim().slice(0, 100),
          splices: n.templateSpans.map((s) => s.expression.getText().replace(/\s+/g, " ")),
          reason,
        });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

describe("importHelpers.ts authors no SQL (BACKLOG-3062)", () => {
  describe("PRECONDITION: the detector can actually detect", () => {
    it("finds a single-line predicate — the shape a line matcher DID catch", () => {
      const found = sqlProducingTemplates("const c = `AND message.date > ${n}`;");
      expect(found).toHaveLength(1);
      expect(found[0].reason).toBe("qualified-column comparison");
    });

    it("finds a MULTI-LINE statement whose opening line carries no keyword", () => {
      // This is the exact shape that separated six from four: the backtick sits
      // on a line holding no SQL at all. A node-based pass sees the whole
      // template; a line-based one sees the first line.
      const src = "const rows = await all(`\n  SELECT COUNT(*) FROM message\n  WHERE guid IS NOT NULL ${clause}\n`);";
      const found = sqlProducingTemplates(src);
      expect(found).toHaveLength(1);
      expect(found[0].reason).toBe("statement keyword");
    });

    it("finds a template nested inside a .map() callback inside a ternary", () => {
      const src =
        "const p = spans.length === 0 ? '0' : spans.map((s) => `(message.date IS NOT NULL AND message.date > ${s.a})`).join(' OR ');";
      expect(sqlProducingTemplates(src)).toHaveLength(1);
    });
  });

  describe("PRECONDITION: it does NOT fire on prose", () => {
    it("ignores English containing the word and", () => {
      expect(sqlProducingTemplates("const m = `${a} and ${b} were updated`;")).toEqual([]);
    });

    it("ignores a progress bar, a cache key and a log line", () => {
      const src = [
        "const bar = `|${bars}| ${pct}% | ${v}/${t} | ETA: ${eta}s`;",
        "const key = `macos-chat-${chatId}`;",
        "const k = `${messageGuid}:${displayName}`;",
        "const msg = `Imported ${n} messages from ${source} where ${who} selected them`;",
      ].join("\n");
      expect(sqlProducingTemplates(src)).toEqual([]);
    });

    it("ignores a dotted path that is not a comparison", () => {
      expect(sqlProducingTemplates("const p = `${plan.cutoffNano} messages`;")).toEqual([]);
    });
  });

  it("importHelpers.ts contains ZERO SQL-producing interpolating templates", () => {
    const found = sqlProducingTemplates(fs.readFileSync(TARGET, "utf8"), TARGET);
    // Exact list, not a count — a count cannot tell a new violation from a
    // different one that replaced it.
    expect(
      found.map((f) => `:${f.line}  ${f.reason}  ${f.statics}`),
    ).toEqual([]);
  });
});
