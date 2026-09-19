/**
 * Branded SQL fragment builders — BACKLOG-3085 (Phase B of the SQL brand).
 *
 * ## Why these exist
 *
 * `sqlText.ts`'s tag refuses to splice a value, which is the whole point. But real
 * statements splice FRAGMENTS: a placeholder list whose length is the number of
 * bound parameters, a `SET a = ?, b = ?` list assembled from the columns actually
 * being written. Those are SQL text, not data, and before this item they were built
 * with `["?", "?"].join(", ")` — a `string`, which the tag correctly refuses.
 *
 * Each builder here is BODIED, so the compiler checks that it really produces the
 * brand; nothing is asserted or cast. That is the shape
 * `electron/types/__typefixtures__/conduitSeam/OK1_bodiedFragmentHelper.ts` pins as
 * the legitimate Phase B path and asserts must NOT trip the seam guard.
 *
 * ## Why not `sqlText.ts`
 *
 * `sqlText.escapeSet.test.ts` asserts that module exports exactly
 * `["SafeSql", "sql", "unsafeSql"]` — the producible surface is the thing under
 * guard, and it does not grow to hold conveniences. These are ordinary consumers of
 * the tag, so they live in an ordinary module.
 *
 * ## Byte-identity
 *
 * Both builders replace a specific `Array.prototype.join` idiom, and
 * `__tests__/sqlFragments.test.ts` asserts they emit the SAME CHARACTERS that idiom
 * emitted — transcribed from the pre-conversion tree, not re-derived from these
 * functions. A builder that produced an equivalent-but-different string would be a
 * silent data change at 262 call sites.
 */
import { sql, type SafeSql } from "./sqlText";

/**
 * `n` bound-parameter markers, comma separated: `?, ?, ?`.
 *
 * Replaces `new Array(n).fill("?").join(", ")` and
 * `items.map(() => "?").join(", ")`, which are the same string by two spellings.
 *
 * The separator defaults to `", "`; `contactOriginLink` and `emailSyncSql` join with
 * a bare `","`, and passing it keeps their statements byte-identical.
 *
 * `n <= 0` yields the empty fragment, matching what `join` did for an empty array.
 * Callers already guard against an empty `IN ()`; this does not add a second,
 * differently-behaving guard on top of the one they have.
 */
export function placeholderList(n: number, separator: SafeSql = sql`, `): SafeSql {
  let out = sql``;
  for (let i = 0; i < n; i += 1) {
    out = i === 0 ? sql`?` : sql`${out}${separator}?`;
  }
  return out;
}

/**
 * Fragments joined by a fragment separator.
 *
 * Replaces `parts.join(", ")` / `parts.join(" AND ")` where `parts` is SQL text.
 * The separator is itself `SafeSql`, so `join`ing with data is not expressible —
 * which is the same rule the tag enforces, held one level up.
 */
export function joinFragments(parts: readonly SafeSql[], separator: SafeSql): SafeSql {
  let out = sql``;
  for (let i = 0; i < parts.length; i += 1) {
    out = i === 0 ? parts[i] : sql`${out}${separator}${parts[i]}`;
  }
  return out;
}
