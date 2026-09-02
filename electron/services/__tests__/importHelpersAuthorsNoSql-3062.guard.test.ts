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
 * ## WHAT THIS GUARD DOES NOT CATCH — read this before trusting it
 *
 * MEASURED, not estimated. Each row below was run through the detector:
 *
 *     FIRES    `AND message.date > ${n}`                            uppercase, qualified
 *     FIRES    `and message.date > ${n}`                            LOWERCASE, qualified
 *     FIRES    `SELECT ... FROM message WHERE ... ${clause}`         statement keyword
 *     silent   `Imported ${n} messages from ${x} where ${y} chose`   prose
 *     silent   `select external_id from messages limit ${n}`         <-- THE GAP
 *
 * **The gap is lowercase STATEMENT keywords with no qualified-column
 * comparison.** `QUALIFIED_COMPARISON` carries `/i`, so lowercase alone does not
 * defeat the guard — only lowercase SQL that also never compares a `table.column`
 * gets through. That is narrower than "lowercase SQL is missed", and the
 * narrower statement is the true one. An overstated limit invites the next
 * reader to skip the guard, which costs more than the gap does.
 *
 * Also uncaught: SQL assembled by concatenation through several variables, or a
 * string built in another file and returned.
 *
 * ## THIS GUARD DOES NOT CLOSE ITS CLASS, AND MUST NOT BE CITED AS DOING SO
 *
 * It is a floor over one file. The class — "SQL authored where no database verb
 * is called, so the boundary gate cannot see it" — is closed by **BACKLOG-3064**:
 * a branded SQL value only `db/` can mint, which makes the property a
 * compile-time one instead of a heuristic, and closes BACKLOG-3044 by
 * construction as well.
 *
 * If you are reading this because you want to claim the class is handled: it is
 * not. Check 3064.
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

    it("DOCUMENTED GAP, asserted so the header cannot drift from the behaviour", () => {
      // Lowercase statement keywords with no qualified-column comparison get
      // through. Asserted rather than described: if a future tightening closes
      // this, THIS TEST GOES RED and the header must be corrected with it.
      expect(
        sqlProducingTemplates("const q = `select external_id from messages limit ${n}`;"),
      ).toEqual([]);
    });

    it("lowercase does NOT defeat the qualified-column half", () => {
      // The gap is narrower than "lowercase is missed" — this is the evidence.
      const found = sqlProducingTemplates("const c = `and message.date > ${n}`;");
      expect(found).toHaveLength(1);
      expect(found[0].reason).toBe("qualified-column comparison");
    });
  });

  it("importHelpers.ts contains ZERO SQL-producing interpolating templates", () => {
    const found = sqlProducingTemplates(fs.readFileSync(TARGET, "utf8"), TARGET);
    // Exact list, not a count — a count cannot tell a new violation from a
    // different one that replaced it.
    //
    // The limit travels with the failure, not only with the header: whoever sees
    // this go red is the person most likely to conclude the file is now clean.
    const offenders = found.map((f) => `:${f.line}  ${f.reason}  ${f.statics}`);
    expect(offenders).toEqual([]);

    // A GREEN RESULT HERE IS A FLOOR, NOT A CLEARANCE.
    // Uncaught: lowercase statement keywords with no `table.column` comparison
    // (`select id from t limit ${n}`), SQL concatenated through several
    // variables, and SQL built in another file and returned.
    // The class is closed by BACKLOG-3064's branded SQL value, not by this test.
    expect(offenders).toHaveLength(0);
  });
});
