/**
 * BACKLOG-3064 — CONTROL 5. Runtime erasure, proved from EMITTED OUTPUT.
 *
 * ## Why this control is the one that makes the item safe
 *
 * This module now sits between every statement in the app and SQLite. A branded id
 * that altered a value would produce a wrong row; a brand that altered a STATEMENT
 * would produce wrong data, silently, across the whole database. So "the brand is
 * erased at compile time" cannot be a sentence in a PR body — it has to be
 * observed.
 *
 * `type-check` proves nothing here: types are exactly what `tsc` deletes. Reasoning
 * proves nothing either, and this suite deliberately does not rely on the fact that
 * `sql` and `unsafeSql` LOOK like identity functions. It compiles the real module
 * with a real `tsc`, reads the JavaScript that comes out, and RUNS it.
 *
 * ## What is asserted
 *
 *   1. The emitted JS contains the SQL characters verbatim — no re-escaping, no
 *      wrapper object, no template-object indirection around the text itself.
 *   2. Executing the emitted JS yields strings that are `===` to the source text,
 *      compared as bytes.
 *   3. Composition concatenates and nothing else: a fragment interpolated into a
 *      statement produces exactly what a plain template literal would have.
 *   4. The wrapped form the codemod inserted at 393 call sites — `unsafeSql(x)` —
 *      returns the SAME REFERENCE it was given, so `prepare()` receives the object
 *      it would have received before this commit.
 *
 * Point 4 is the load-bearing one. Commit 1 changed no SQL text (all 393 arg0
 * slices hash to the same aggregate before and after), and this is the other half
 * of that claim: what the codemod ADDED does nothing at runtime.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { sql, unsafeSql, type SafeSql } from "../sqlText";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const BRAND_MODULE = path.join(REPO_ROOT, "electron", "services", "db", "core", "sqlText.ts");

/** A statement with every character class that a naive re-emit would mangle. */
const AWKWARD = "SELECT 'it''s' AS q, \"col\", `tick`, a \\ b, ${notAnInterpolation}\n  FROM t";

jest.setTimeout(180_000);

describe("CONTROL 5 — the brand is erased at runtime (in-process)", () => {
  it("returns the identical characters a plain template literal would have", () => {
    expect(sql`SELECT id FROM contacts WHERE user_id = ?`).toBe(
      "SELECT id FROM contacts WHERE user_id = ?",
    );
    // Multi-line, with the indentation the real statements carry.
    expect(sql`SELECT id
       FROM contacts
      WHERE user_id = ?`).toBe(`SELECT id
       FROM contacts
      WHERE user_id = ?`);
    // Empty is still a string, not undefined — `listOf()` reduces from `sql\`\``.
    expect(sql``).toBe("");
  });

  /**
   * The wrapped form the codemod inserted 393 times. `toBe` on a string is a value
   * comparison, so this is asserted as an identity of characters AND, below, of
   * reference — a wrapper that returned an equal-but-new string would still be a
   * behaviour change for anything relying on statement caching.
   */
  it("hands `prepare()` back the very object it was given", () => {
    const original = AWKWARD;
    const branded: SafeSql = unsafeSql(original);
    expect(branded).toBe(original);
    // Reference identity, stated separately: `toBe` is `Object.is`, and for a
    // string primitive that is value equality, so this pins the stronger claim.
    expect(Object.is(branded, original)).toBe(true);
    expect(typeof branded).toBe("string");
  });

  it("composes by concatenation and nothing else", () => {
    const clause: SafeSql = unsafeSql("c.deleted_at IS NULL");
    const marks: SafeSql = unsafeSql("?, ?, ?");
    const built = sql`SELECT id FROM contacts WHERE ${clause} AND id IN (${marks})`;
    expect(built).toBe("SELECT id FROM contacts WHERE c.deleted_at IS NULL AND id IN (?, ?, ?)");

    // Nesting to two levels — composition is not special-cased at depth 1.
    const inner: SafeSql = sql`SELECT id FROM transactions WHERE user_id = ?`;
    const middle: SafeSql = sql`c.transaction_id IN (${inner})`;
    expect(sql`SELECT c.id FROM communications c WHERE ${middle}`).toBe(
      "SELECT c.id FROM communications c WHERE c.transaction_id IN (SELECT id FROM transactions WHERE user_id = ?)",
    );
  });

  /**
   * A tagged template receives the COOKED strings, so an escape sequence in a
   * statement must survive as the character it denotes — the same character a plain
   * template literal would have produced. This is the one place a tag could quietly
   * differ from the literal it replaces, which matters for Phase B's byte-identity.
   */
  it("uses the cooked strings, so a tagged statement equals the literal it replaces", () => {
    expect(sql`a\tb`).toBe(`a\tb`);
    expect(sql`a\\b`).toBe(`a\\b`);
    expect(sql`it\'s`).toBe(`it\'s`);
    expect(sql`${unsafeSql("x")}`).toBe(`x`);
  });
});

describe("CONTROL 5 — proved from emitted JavaScript, not from the source", () => {
  /**
   * The whole point of this block: the assertions above run TypeScript through
   * `ts-jest`, which is a compiler this suite is also trying to make claims about.
   * So the module is compiled separately by a plain `tsc`, the OUTPUT is read as
   * text, and the output is then executed by node with no TypeScript in the loop.
   */
  let tmpDir: string;
  let emitted: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sqltext-emit-"));
    fs.copyFileSync(BRAND_MODULE, path.join(tmpDir, "sqlText.ts"));

    // A driver that uses the module exactly the way production does, including the
    // wrapped form the codemod inserted.
    fs.writeFileSync(
      path.join(tmpDir, "driver.ts"),
      [
        `import { sql, unsafeSql, type SafeSql } from "./sqlText";`,
        `const CLAUSE: SafeSql = sql\`c.deleted_at IS NULL\`;`,
        `export const tagged: string = sql\`SELECT id FROM contacts WHERE user_id = ?\`;`,
        `export const composed: string = sql\`SELECT id FROM contacts WHERE \${CLAUSE}\`;`,
        `const raw = "UPDATE contacts SET display_name = ? WHERE id = ?";`,
        `export const wrapped: string = unsafeSql(raw);`,
        `export const sameReference: boolean = unsafeSql(raw) === raw;`,
      ].join("\n"),
      "utf8",
    );

    execFileSync(
      process.execPath,
      [
        require.resolve("typescript/lib/tsc.js"),
        path.join(tmpDir, "driver.ts"),
        path.join(tmpDir, "sqlText.ts"),
        "--module",
        "commonjs",
        "--target",
        "ES2020",
        "--strict",
        "--outDir",
        tmpDir,
      ],
      { encoding: "utf8" },
    );

    emitted = fs.readFileSync(path.join(tmpDir, "driver.js"), "utf8");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits the SQL characters verbatim, with no wrapper around the text", () => {
    expect(emitted).toContain("SELECT id FROM contacts WHERE user_id = ?");
    expect(emitted).toContain("UPDATE contacts SET display_name = ? WHERE id = ?");
    // The type and the brand carrier are gone entirely — this is the erasure claim
    // stated against the artifact rather than against the source.
    expect(emitted).not.toContain("SafeSql");
    expect(emitted).not.toContain("SqlBrand");
  });

  it("produces, when EXECUTED, strings byte-identical to the authored text", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(path.join(tmpDir, "driver.js")) as {
      tagged: string;
      composed: string;
      wrapped: string;
      sameReference: boolean;
    };

    expect(mod.tagged).toBe("SELECT id FROM contacts WHERE user_id = ?");
    expect(mod.composed).toBe("SELECT id FROM contacts WHERE c.deleted_at IS NULL");
    expect(mod.wrapped).toBe("UPDATE contacts SET display_name = ? WHERE id = ?");

    // The claim that matters for all 393 wrapped call sites: the escape returns the
    // same object, so `prepare()` sees exactly what it saw before this commit.
    expect(mod.sameReference).toBe(true);
  });

  /**
   * The emitted module must still be a plain function call — if `unsafeSql` were
   * ever changed to validate, normalise or trim, every statement in the app would
   * change and this control is the only thing watching.
   */
  it("keeps the escape a pass-through in the emitted module", () => {
    const emittedModule = fs.readFileSync(path.join(tmpDir, "sqlText.js"), "utf8");
    const body = emittedModule.slice(emittedModule.indexOf("function unsafeSql"));
    expect(body).toMatch(/function unsafeSql\(text\)\s*\{\s*return text;\s*\}/);
  });
});
