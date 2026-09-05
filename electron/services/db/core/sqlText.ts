/**
 * SQL text as a type — BACKLOG-3064.
 *
 * ## Why a type, when a matcher already exists
 *
 * The rule "SQL text lives in `electron/services/db/**`" is enforced today by
 * `scripts/ci/check-sql-boundary.mjs`, which enumerates CALL SITES OF DATABASE
 * VERBS. Everything it cannot see is a way of producing SQL without calling one,
 * and four separate items found four different ways:
 *
 *   BACKLOG-3044   no verb at the authoring site — the caller passes `sql: string`
 *   BACKLOG-3062   no verb at the authoring site — a template RETURNS SQL
 *   BACKLOG-3059   the verb was not in the verb set
 *   BACKLOG-3049   the file was not in `git ls-files`, so it was never enumerated
 *
 * **The property is not lexical, so no lexical instrument can hold it.** This is a
 * defect:
 *
 *     AND message.date > ${cutoffNano}
 *
 * and this is prose:
 *
 *     `${name} and ${other} were both updated`
 *
 * No matcher can separate them, because the distinguishing fact is not in the text
 * — it is what the value is FOR. Tighten the pattern and it misses the defect;
 * loosen it and it fires on ordinary sentences, becomes noise, and is switched off
 * inside a week.
 *
 * A type separates them without reading the text at all: the prose template is
 * never passed to a database verb, so nothing ever asks it for a `SafeSql`.
 *
 * ## The division of labour — these are not two halves of one mechanism
 *
 * **The SIGNATURE is the enforcement.** `better-sqlite3`'s
 * `prepare(source: string)` lives in `node_modules` and cannot be made to demand a
 * brand, so enforcement can only happen at signatures we own: the conduit in
 * `dbConnection.ts`.
 *
 * **The TAG is not enforcement — it is what makes the safe path the easy one.**
 * Every defect in this epic came from someone doing the natural thing. A tag whose
 * interpolations must themselves be SQL makes the natural thing correct at the
 * keystroke, rather than correct-if-you-remember and caught later by review.
 *
 * Neither alone is the fix. A tag with no signature demanding it is advisory. A
 * brand with no tag invites `unsafeSql(buildString())` as the normal path. The repo
 * owns the negative example: `sqlFieldWhitelist.ts` (BACKLOG-2739) was a whitelist
 * whose types had silently widened to `string` — a guard that looked like a
 * constraint and constrained nothing.
 *
 * ## Compile-time only
 *
 * `SafeSql` is an intersection with `string`, so a branded statement IS a string
 * everywhere a string is legitimate — `prepare()`, logging, `JSON.stringify`, a
 * plain `string` parameter. Nothing is wrapped or boxed. `sql` and `unsafeSql` are
 * ordinary functions returning the same characters they were given, and
 * `__tests__/sqlText.runtimeIdentity.test.ts` proves that FROM EMITTED OUTPUT
 * rather than from this paragraph.
 *
 * That matters more here than for a branded id: this module sits between every
 * statement in the app and SQLite. If it altered one character of one statement,
 * the change would be a data defect, not a type defect.
 *
 * ## What this commit does NOT enforce — claimed, not hidden
 *
 * - **`getRawDatabase()` (29 call sites, 28 outside `db/`)** hands out the raw
 *   `better-sqlite3` handle, whose `prepare` takes `string`. Anything holding that
 *   handle bypasses this module completely. It is a second, independent choke
 *   point and it is **Phase B**; commit 1 would be unreviewable with both.
 * - **`ensureDb()` is a SECOND exported raw-handle exit, and this list used to name
 *   only the first.** `dbConnection.ts` exports it, and it returns the same
 *   `better-sqlite3` handle. Measured: two production consumers, of which exactly one
 *   is outside `db/` — `sqliteBackupService.ts:101`, which calls only `.pragma`, not
 *   `.prepare`. So nothing exploits it today; it is recorded here so Phase B inherits
 *   an accurate list of exits rather than a short one. (Found in SR review of
 *   PR #2488, BACKLOG-3086.)
 * - ~~**The `sql` tag has ZERO production call sites in this commit.**~~ **No longer
 *   true, and the sentence is corrected rather than deleted so the reader can see
 *   what changed.** That was Phase A. **BACKLOG-3085 (Phase B) converted 258 of the
 *   262 in-layer escapes**, so the tag is now the ordinary way a statement is
 *   written inside `db/**` and the escape is what it was named as. The counted
 *   escape stands at **135**: 131 outside the layer (BACKLOG-3044, unchanged) and 4
 *   inside it that CANNOT use the tag because they splice a value into SQL text
 *   (BACKLOG-3102).
 * - **Fragments are branded by BODIED helpers, not by escapes.** `core/sqlFragments.ts`
 *   (placeholder lists, fragment joins) and `core/columnSql.ts` (every whitelisted
 *   column name, enumerated under a `satisfies`) are the shape
 *   `electron/types/__typefixtures__/conduitSeam/OK1_bodiedFragmentHelper.ts` pins as
 *   legitimate: the compiler checks the return, so nothing is taken on trust. They
 *   are NOT exported from here — `__tests__/sqlText.escapeSet.test.ts` asserts this
 *   module exports exactly three names, because the producible surface is the thing
 *   under guard and it does not grow to hold conveniences.
 * - **A cast that names `SafeSql` still compiles.** It is counted by
 *   `__tests__/sqlText.escapeSet.test.ts`, which is a ratchet, not a prohibition —
 *   and that matcher compares a NAME against a set, which cannot be exhaustive over
 *   type identity. **BACKLOG-3072 owns that limit.**
 * - **Routes that never name the brand at all** — the conduit's own signature being
 *   widened, and unchecked declarations minting it — are held by
 *   `__tests__/sqlText.conduitSeam.test.ts` (BACKLOG-3086), by symbol and type
 *   identity rather than by name. Its header states what it covers and what it does
 *   not. **Not every residue there has an owner**: a brand in the PARAMETER of a
 *   bodiless declaration (`declare function withSql(cb: (s: SafeSql) => void): void`)
 *   is unowned by any item today. Saying "with an owner for each" was easier to write
 *   than to check, and it was false.
 * - **Switching the compiler off entirely still works.** `// @ts-expect-error` above
 *   a conduit call compiles (measured, exit 0), avoids both of the seams above, and
 *   names nothing. `@typescript-eslint/ban-ts-comment` is `warn` and therefore
 *   blocks nothing — the same shape as the `any` route, and **BACKLOG-3073's**
 *   family.
 */

/**
 * The brand carrier. **Deliberately NOT exported.**
 *
 * A `unique symbol` is nominal: no other declaration anywhere can produce a type
 * that satisfies `{ readonly [SqlBrand]: true }`, because nothing else can NAME
 * `SqlBrand`. So a caller outside this module cannot re-declare `SafeSql`
 * structurally and mint its own.
 *
 * **That closes structural re-declaration. It does NOT mean every remaining forgery
 * has to name `SafeSql`** — an earlier version of this sentence said exactly that
 * and was wrong. BACKLOG-3086 compiled 23 forms one at a time under the real
 * settings: 19 reached a conduit parameter with an unbranded value and 4 were
 * already refused. TWO WHOLE FAMILIES never mention the type in any spelling:
 * widening the CONDUIT'S OWN SIGNATURE (`dbAll as (s: string) => unknown[]`, or an
 * ordinary assignment into a method-syntax slot, where `strictFunctionTypes` does
 * not apply), and stating `SafeSql` as the output of a declaration the compiler
 * never checks against a body (an overload signature, an ambient `declare`, a type
 * predicate). `__tests__/sqlText.conduitSeam.test.ts` watches both families, resolving
 * symbols and type identity through the checker instead of matching names.
 *
 * **It does not hold them completely, and this paragraph used to say it did.** Three
 * shapes were found walking past it AFTER it shipped — an interface method's return
 * reached through an ambient const, an index signature, and a mapped type — because
 * the walk visited only some of the axes a type holds another type on. Those are now
 * closed. What is knowingly still open, and stated rather than implied:
 *
 * - `const m = { make: (s: string) => s } as Maker`, where
 *   `interface Maker { make(s: string): SafeSql }`. The ASSERTION names no brand, and
 *   the interface member is not an unchecked position — both an object literal
 *   ANNOTATED `: Maker` and a CLASS implementing it are refused (TS2322, TS2416).
 *   **BACKLOG-3072 owns it**: closing it means resolving the assertion's TARGET
 *   through the checker.
 * - A brand in a PARAMETER of a bodiless declaration. **Unowned.**
 * - `// @ts-expect-error`. **BACKLOG-3073's family.**
 *
 * (A string-literal brand — `{ readonly __brand: "SafeSql" }`, the shape
 * `electron/types/ids.ts` uses — would be structurally reproducible by anyone who
 * types the same literal. That is acceptable for row ids, where the risk is a mixed
 * up id; it is not acceptable here, where the brand is the only thing standing
 * between hand-built text and the database.)
 */
declare const SqlBrand: unique symbol;

/**
 * SQL text that came from the tag below, or from a counted escape.
 *
 * It is a `string` — assignable to every `string` position, including
 * `better-sqlite3`'s `prepare`. What it is NOT is assignable FROM a string: that
 * one direction is the whole mechanism.
 */
export type SafeSql = string & { readonly [SqlBrand]: true };

/**
 * The tagged template. **The only producer that verifies anything.**
 *
 * ```ts
 * const ACTIVE = sql`c.deleted_at IS NULL`;
 * dbAll<Row>(sql`SELECT id FROM contacts WHERE user_id = ? AND ${ACTIVE}`, [userId]);
 * ```
 *
 * ## Why `...values: SafeSql[]` is the entire point
 *
 * An interpolation is legal only if it is ITSELF already SQL. So:
 *
 *     sql`... WHERE message.date > ${cutoffNano}`   // does not compile: a number is not SQL
 *     sql`... WHERE ${ACTIVE_CONTACTS_CLAUSE}`      // compiles: a clause is SQL
 *
 * The first line is BACKLOG-3062, dead at the authoring site rather than refused at
 * the boundary. Values belong in the `params` array, where SQLite binds them; that
 * is what the second parameter of every conduit verb is for.
 *
 * Composition is not a concession — it is what makes the tag usable for real
 * statements. Measured at `2e73ad37f`, **39 conduit call sites interpolate, and
 * every one of them splices a fragment** (a predicate, a column list, a generated
 * placeholder list). None splices a value. Phase B can therefore convert them by
 * branding the fragment, with no statement rewritten.
 *
 * `strings` is the COOKED array, so the text produced is exactly what a plain
 * template literal would have produced. That is what makes Phase B's conversions
 * byte-identical, and it is asserted rather than assumed.
 */
export function sql(strings: TemplateStringsArray, ...values: SafeSql[]): SafeSql {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += values[i] + strings[i + 1];
  }
  return out as SafeSql;
}

/**
 * THE COUNTED ESCAPE. Asserts, without evidence, that a string is safe SQL.
 *
 * This is a function rather than an inline `as SafeSql` for one reason: **an inline
 * cast is invisible and a named call can be counted.** `__tests__/sqlText.escapeSet.test.ts`
 * enumerates every call site by AST and asserts the EXACT per-file map with an
 * owner for each file — not a `<=` threshold. Under a threshold you can add six
 * escapes and stay green until someone counts by hand. Under an exact map, adding,
 * moving or removing one fails there, with the diff printed, and whoever did it has
 * to say so in the PR.
 *
 * **Every call site in the tree today was inserted mechanically by commit 1 and is
 * pre-registered.** The count starts at its maximum and may only fall. A migration
 * whose tolerated-exception count can rise is not a migration.
 *
 * Do not add one. If you are writing a new statement inside `db/`, use the tag. If
 * you are writing one outside `db/`, the statement belongs in `db/` — that is
 * BACKLOG-3044, and it is the rule this whole module exists to make checkable.
 */
export function unsafeSql(text: string): SafeSql {
  return text as SafeSql;
}
