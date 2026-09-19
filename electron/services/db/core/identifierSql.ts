/**
 * Runtime-generated SQL IDENTIFIERS, as branded text — BACKLOG-3102 PR 2.
 *
 * ## Why an identifier needs its own producer
 *
 * SQLite cannot bind an identifier. A table name has to reach the statement as
 * TEXT, and the `sql` tag refuses to splice a `string` — correctly, because it
 * cannot tell a table name from a value. `core/columnSql.ts` answers that for
 * COLUMN names by enumerating them: the whitelist is closed, so the only column
 * names that exist as SQL are the ones on it.
 *
 * **A staging table name cannot be enumerated.** It carries a token from
 * `crypto.randomUUID()` (`stagingDdlSql.ts:67`), so the set of legal names is not
 * knowable at compile time. What IS closed is the set of CHARACTERS such a name
 * may contain. So this module generalises `columnSql.ts` from a closed value set
 * to a closed CHARACTER set, which is the smallest closed thing available here.
 *
 * ## Why this is not `unsafeSql` wearing a hat
 *
 * The obvious design is `unsafeSql(`"${name}"`)` behind a `StagingTableName`
 * parameter: one counted escape, permanently owned, discharged by
 * `checkedStagingTable`'s anchored regex. It was considered and REJECTED, because
 * it leaves a live laundering route.
 *
 * `checkedStagingTable` mints the brand with `return name as StagingTableName`
 * (`stagingDdlSql.ts:111`). That assertion names neither `SafeSql` nor
 * `unsafeSql`, so `__tests__/sqlText.escapeSet.test.ts` — a name matcher — does
 * not count it, and `sqlText.conduitSeam.test.ts` does not see it either. Anyone
 * can therefore write `x as unknown as StagingTableName` and hand it to a
 * producer. **That route exists under every design.** What differs is where it
 * ends:
 *
 *   - under `unsafeSql(`"${name}"`)`, a forged `x" ; DROP TABLE emails --` is
 *     laundered into `SafeSql` silently;
 *   - under the builder below it CANNOT be, because `"` and `;` have no entry in
 *     the map and there is nothing to assert. It throws.
 *
 * That is a closure by construction rather than an accounting change, and it is
 * the whole reason this module is worth its lines. `__tests__/identifierSql.test.ts`
 * pins the forged name permanently.
 *
 * ## What this enforces, and what it does NOT — two properties, two mechanisms
 *
 * This module enforces **CHARSET**: every character of the name is one the brand's
 * pattern admits. The `StagingTableName` parameter type enforces **WHICH
 * IDENTIFIER**: the prefix, and the anchoring at both ends. Neither subsumes the
 * other, and **neither verifies that the table exists**. Do not read a passing
 * call as "this is a real staging table".
 *
 * ## The alphabet is DERIVED from the pattern, not chosen
 *
 * `STAGING_NAME_PATTERN` (`stagingDdlSql.ts:89-92`) is
 * `/^staging_emailrecache_[0-9a-f]+_[A-Za-z0-9_]+$/` and its `msgimport_` sibling.
 * The suffix class `[A-Za-z0-9_]` is the UNION of everything either pattern can
 * admit anywhere: the token class `[0-9a-f]` is a subset of it, and so is every
 * character of both prefix literals. Hence 63 entries, below.
 *
 * That reasoning is not left as prose. `__tests__/identifierSql.test.ts` sweeps
 * every code point 0..0xFFFF against the LIVE `checkedStagingTable` and asserts the
 * map and the pattern admit exactly the same characters — **in both directions**,
 * so a missing entry and a too-wide map both fail. The first draft of this design
 * had 37 entries and silently dropped uppercase, which the suffix class admits;
 * the sweep is what caught it, and a sample would not have.
 *
 * ## Not exported from `sqlText.ts`
 *
 * `sqlText.escapeSet.test.ts` asserts the brand module exports exactly
 * `["SafeSql", "sql", "unsafeSql"]` — the producible surface is the thing under
 * guard and it does not grow to hold conveniences. This is an ordinary consumer of
 * the tag, so it lives in an ordinary module, the same way `core/sqlFragments.ts`
 * and `core/columnSql.ts` do. It is BODIED: the compiler checks that it really
 * produces the brand, so nothing is asserted or cast.
 */
import { sql, type SafeSql } from "./sqlText";
import type { StagingTableName } from "../stagingDdlSql";

/** Every character `STAGING_NAME_PATTERN` can admit, anywhere in a name. */
export type IdentChar =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z"
  | "_"
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z";

/**
 * One `SafeSql` fragment per admitted character.
 *
 * `satisfies` rather than an annotation, for the same reason `COLUMN_SQL` uses it:
 * it proves TOTALITY over `IdentChar` (a missing entry is a compile error) without
 * widening the value type. `__tests__/identifierSql.test.ts` additionally asserts
 * every value's characters equal its own key, so an entry cannot silently emit a
 * different character than it is filed under — the same control `columnSql.test.ts`
 * runs.
 */
const IDENT_CHAR_SQL = {
  "0": sql`0`,
  "1": sql`1`,
  "2": sql`2`,
  "3": sql`3`,
  "4": sql`4`,
  "5": sql`5`,
  "6": sql`6`,
  "7": sql`7`,
  "8": sql`8`,
  "9": sql`9`,
  A: sql`A`,
  B: sql`B`,
  C: sql`C`,
  D: sql`D`,
  E: sql`E`,
  F: sql`F`,
  G: sql`G`,
  H: sql`H`,
  I: sql`I`,
  J: sql`J`,
  K: sql`K`,
  L: sql`L`,
  M: sql`M`,
  N: sql`N`,
  O: sql`O`,
  P: sql`P`,
  Q: sql`Q`,
  R: sql`R`,
  S: sql`S`,
  T: sql`T`,
  U: sql`U`,
  V: sql`V`,
  W: sql`W`,
  X: sql`X`,
  Y: sql`Y`,
  Z: sql`Z`,
  _: sql`_`,
  a: sql`a`,
  b: sql`b`,
  c: sql`c`,
  d: sql`d`,
  e: sql`e`,
  f: sql`f`,
  g: sql`g`,
  h: sql`h`,
  i: sql`i`,
  j: sql`j`,
  k: sql`k`,
  l: sql`l`,
  m: sql`m`,
  n: sql`n`,
  o: sql`o`,
  p: sql`p`,
  q: sql`q`,
  r: sql`r`,
  s: sql`s`,
  t: sql`t`,
  u: sql`u`,
  v: sql`v`,
  w: sql`w`,
  x: sql`x`,
  y: sql`y`,
  z: sql`z`,
} satisfies Record<IdentChar, SafeSql>;

/**
 * The same table, indexable by a plain `string`.
 *
 * `Record<IdentChar, SafeSql>` cannot be indexed by a `string` under
 * `noImplicitAny`, and the name arrives as a `string` at runtime — that is the
 * point. A `Map` takes a `string` key honestly and returns `undefined` for a
 * character with no entry, which is exactly the case that must throw.
 */
const IDENT_CHAR_MAP: ReadonlyMap<string, SafeSql> = new Map(
  Object.entries(IDENT_CHAR_SQL),
);

/**
 * A staging table name, quoted, as SQL text.
 *
 * Emits `"<name>"` — the same characters
 * `` `"${stagingTable}"` `` emitted before this module existed, so every statement
 * built through it is byte-identical.
 *
 * **Throws** on a character with no entry. Throwing rather than returning
 * `undefined` or a sanitised name is deliberate and matches `checkedStagingTable`:
 * there is no safe fallback for an identifier about to be spliced into SQL, and a
 * silently-sanitised name would address a table nobody meant.
 *
 * Iterated with `for...of`, so a name containing an astral character yields that
 * whole code point as one `ch` and misses the map — rather than splitting into
 * surrogate halves that might each look innocuous.
 */
export function stagingTableSql(name: StagingTableName): SafeSql {
  let out = sql`"`;
  for (const ch of name) {
    // ANNOTATED, not asserted: the annotation is what makes the `undefined`
    // branch reachable and therefore checkable. An `as SafeSql` here would
    // reintroduce exactly the laundering this module exists to close.
    const frag: SafeSql | undefined = IDENT_CHAR_MAP.get(ch);
    if (frag === undefined) {
      throw new Error(
        `Illegal character ${JSON.stringify(ch)} in staging table name — ` +
          `only [A-Za-z0-9_] is admitted by the staging name pattern.`,
      );
    }
    out = sql`${out}${frag}`;
  }
  return sql`${out}"`;
}
