/**
 * BACKLOG-3085 — CONTROL 1's second leg: the fragments that could NOT be held by a
 * static fingerprint are held here, against transcribed text.
 *
 * ## Why this file exists at all
 *
 * The item's byte-identity control compares, site by site, the SQL text each conduit
 * call site denotes, before and after. It reported **379 of 401 identical**. The 22
 * that moved all moved for one reason, and it is a property of the instrument rather
 * than of the change: where a statement splices a fragment ASSEMBLED AT RUNTIME
 * (`fields.join(", ")`, `ids.map(() => "?").join(", ")`,
 * `LIVE_EMAIL_SQL.replace("%PLACEHOLDERS%", …)`), the fingerprint can only fall back
 * to the expression's SOURCE TEXT — and converting that expression necessarily
 * changes its source.
 *
 * So those 22 are proved a different way, and a stronger one: **the builders that
 * replaced those idioms are asserted to emit the same characters the idioms emitted.**
 * The expected values below are TRANSCRIBED from the pre-conversion tree, not
 * re-derived by running the new code — a test that computed its expectation from the
 * thing under test would pass whatever the new code did.
 *
 * The 22 statements differ from their originals ONLY inside those holes, which the
 * control's own diff prints. So a builder that emits the original characters means
 * the statement emits the original characters. That is the whole argument, and it is
 * stated here rather than left for a reader to reconstruct.
 */
import {
  COLUMN_SQL,
  assignmentList,
  columnList,
  type AnyWhitelistedColumn,
} from "../columnSql";
import { joinFragments, placeholderList } from "../sqlFragments";
import { sql } from "../sqlText";
import { TABLE_FIELDS } from "../../../../utils/sqlFieldWhitelist";

describe("placeholderList emits what the `map/join` idiom emitted", () => {
  /** The idiom this replaced, kept here as the ORACLE rather than as a memory. */
  const oldIdiom = (n: number, sep = ", "): string =>
    new Array(n).fill("?").join(sep);

  it.each([0, 1, 2, 3, 7, 400])("matches for n = %i, default separator", (n) => {
    expect(placeholderList(n)).toBe(oldIdiom(n));
  });

  it("matches for the bare-comma separator contactOriginLink and emailSyncSql use", () => {
    for (const n of [0, 1, 2, 5, 400]) {
      expect(placeholderList(n, sql`,`)).toBe(oldIdiom(n, ","));
    }
  });

  /**
   * The separator is the reason this test exists rather than being obvious.
   * `contactOriginLink` joins with `","` and everything else with `", "`; a builder
   * that ignored the separator would emit a statement that still WORKS and is not
   * the statement that shipped.
   */
  it("distinguishes the two separators — a builder ignoring it would pass a weaker test", () => {
    expect(placeholderList(3, sql`,`)).toBe("?,?,?");
    expect(placeholderList(3)).toBe("?, ?, ?");
    expect(placeholderList(3, sql`,`)).not.toBe(placeholderList(3));
  });
});

describe("joinFragments emits what `Array.join` emitted", () => {
  it("joins fragments with the separator, including the multi-line one", () => {
    // `parts` is the ORACLE — the plain strings the old `join` operated on — and
    // `branded` is the same three fragments through the tag. No cast: a cast naming
    // the brand is exactly what `sqlText.escapeSet.test.ts` forbids outside the
    // module that defines it.
    const parts = ["(a LIKE ?)", "(b LIKE ?)", "(c LIKE ?)"];
    const branded = [sql`(a LIKE ?)`, sql`(b LIKE ?)`, sql`(c LIKE ?)`];
    expect(branded).toEqual(parts);
    expect(joinFragments(branded, sql` AND `)).toBe(parts.join(" AND "));
    expect(joinFragments(branded, sql` OR `)).toBe(parts.join(" OR "));
    // contactDbService's multi-word search joins on a newline plus indentation.
    expect(joinFragments(branded, sql`\n       AND `)).toBe(parts.join("\n       AND "));
  });

  it("is empty for no parts and is the part itself for one", () => {
    expect(joinFragments([], sql`, `)).toBe("");
    expect(joinFragments([sql`only`], sql`, `)).toBe("only");
  });
});

describe("COLUMN_SQL is the whitelist, and says the column it is filed under", () => {
  /**
   * The `satisfies` in `columnSql.ts` already makes a MISSING column a compile
   * error. What it cannot check is that an entry's TEXT matches its key — a
   * copy-paste that filed `sql\`user_id\`` under `owner_id` would compile and would
   * silently write the wrong column. That is what this asserts.
   */
  it("emits each column name verbatim", () => {
    const entries = Object.entries(COLUMN_SQL);
    expect(entries.length).toBeGreaterThan(100);
    for (const [name, text] of entries) expect([name, String(text)]).toEqual([name, name]);
  });

  /**
   * The set, by enumeration rather than by count: every column of every whitelisted
   * table is present. A count would pass if one column were swapped for another.
   */
  it("covers every column of every whitelisted table", () => {
    const wanted = new Set<string>();
    for (const cols of Object.values(TABLE_FIELDS)) for (const c of cols) wanted.add(c);
    const have = new Set(Object.keys(COLUMN_SQL));
    expect([...wanted].filter((c) => !have.has(c))).toEqual([]);
  });
});

describe("columnList and assignmentList emit what the writers emitted", () => {
  const cols = ["display_name", "company", "title"] as AnyWhitelistedColumn[];

  it("columnList matches `columns.join(\", \")`", () => {
    expect(columnList(cols)).toBe(cols.join(", "));
    expect(columnList([])).toBe("");
  });

  it("assignmentList matches `columns.map((c) => `${c} = ?`).join(\", \")`", () => {
    expect(assignmentList(cols)).toBe(cols.map((c) => `${c} = ?`).join(", "));
    expect(assignmentList(["email"] as AnyWhitelistedColumn[])).toBe("email = ?");
  });

  /** Order is the caller's, and it has to survive: the params array is positional. */
  it("preserves the caller's column order", () => {
    const reversed = [...cols].reverse();
    expect(assignmentList(reversed)).toBe(reversed.map((c) => `${c} = ?`).join(", "));
    expect(assignmentList(reversed)).not.toBe(assignmentList(cols));
  });
});
