/**
 * Branded row identifiers — BACKLOG-3067.
 *
 * ## The defect this exists to make impossible
 *
 * `hybridExtractorService.ts:399` calls `linkCommunicationToTransaction(emailId, ...)`.
 * The parameter is named `communicationId`. `communications.id` is a fresh
 * `randomUUID()`; the email's id lives in `communications.email_id`. So the
 * `UPDATE ... WHERE id = ?` matches zero rows, and the caller logs success
 * (BACKLOG-2829 — still live, still unfixed, deliberately not fixed here).
 *
 * Nothing caught it. Both values are `string`. The SQL is single-table and every
 * column is in scope, so there is nothing structurally wrong with the statement —
 * a query builder types `communications.id` as `string` too, and the parameter was
 * already *named* correctly, which did not help either. The only mechanism that
 * separates the two is making them **different types**.
 *
 * ## The rule
 *
 *   LOOKUPS take `string` and MINT the brand.  MUTATIONS DEMAND the brand.
 *
 * A read handed the wrong kind of id returns `null`. It cannot corrupt anything,
 * so it is not worth protecting — and leaving it unbranded is what keeps this a
 * ratchet instead of a repo-wide sweep. A *write* handed the wrong kind of id
 * silently changes nothing and says it worked. That is the one that must not
 * compile.
 *
 * The rule also gives the brand real provenance for free: the ordinary way to
 * hold a `CommunicationId` is to have read a communication row out of the
 * database. Nothing needs to remember to brand anything.
 *
 * ## Compile-time only
 *
 * The intersection with `string` means a branded id IS a string everywhere a
 * string is legitimate — template literals, `JSON.stringify`, `Map` keys, logging,
 * a plain `string` parameter. Nothing is erased, wrapped or boxed at runtime; the
 * type vanishes at compile time. `brandedIds.runtimeIdentity.test.ts` proves it,
 * because a brand that changed runtime behaviour would break the app in ways tsc
 * cannot see.
 *
 * If the brand broke ordinary string use it would be cast away everywhere within
 * a week and buy nothing. That is control 3, and it is why the satisfiability
 * fixture is as long as the failing ones.
 */

import type { Communication, Email, Transaction } from "./models";

// ============================================================================
// The brands
// ============================================================================

/** `communications.id` — the junction row's own id. */
export type CommunicationId = string & { readonly __brand: "CommunicationId" };

/** `emails.id` — the email CONTENT row. Not interchangeable with the above. */
export type EmailId = string & { readonly __brand: "EmailId" };

/** `transactions.id` — a deal. */
export type TransactionId = string & { readonly __brand: "TransactionId" };

// ============================================================================
// Row types — the mints
// ============================================================================

/**
 * These are INTERSECTIONS, not rewrites, and that is the whole reason this pass
 * is affordable. `CommunicationRow` is assignable to `Communication` and `row.id`
 * is assignable to every `string` position, so **no existing consumer changes**.
 * Only code that *demands* a brand pays anything.
 *
 * `Communication` is an alias of `Message` (the renderer's primary content type),
 * so `Message.id` itself is deliberately NOT branded — that would be a repo-wide
 * sweep. The brand is attached at the db read instead.
 *
 * Where the brand actually comes from: `dbGet<T>` / `dbAll<T>` end in
 * `stmt.get(...) as T`. That assertion already exists and already verifies nothing
 * about the row's shape. Naming the row type `CommunicationRow` rather than
 * `Communication` therefore adds **no new unsoundness and no new cast** — it names
 * a property of an assertion the db layer was already making.
 */
export type CommunicationRow = Communication & { id: CommunicationId };

/** An `emails` row read out of the database. */
export type EmailRow = Email & { id: EmailId };

/** A `transactions` row read out of the database. */
export type TransactionRow = Transaction & { id: TransactionId };

// ============================================================================
// Named escapes — asserted, not checked
// ============================================================================

/**
 * THESE ARE ESCAPES. Each one asserts, without evidence, that a bare string is a
 * particular kind of row id — exactly the claim the brands exist to stop anyone
 * making by accident. They are functions rather than inline `as` casts for one
 * reason: an inline cast is invisible, and a named call can be counted.
 *
 * `brandedIds.escapeSet.test.ts` enumerates every call site of these helpers and
 * asserts the EXACT set — file path to count, not a `<=` threshold. A tolerated-
 * exception count that can rise is not a migration.
 *
 * Do not reach for these in production code. If a write needs a branded id, read
 * the row first: the read is the verification, and it costs nothing.
 */
export function asCommunicationId(id: string): CommunicationId {
  return id as CommunicationId;
}

export function asEmailId(id: string): EmailId {
  return id as EmailId;
}

export function asTransactionId(id: string): TransactionId {
  return id as TransactionId;
}
