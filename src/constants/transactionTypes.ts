/**
 * Transaction type display labels (renderer).
 *
 * THE LABEL HAS MOVED TWICE. It shipped as "Purchase"; support ticket 112 (a
 * live user) asked for the seller-side convention "Listing and Sale"; the
 * founder ruled "Listing/Purchase" (BACKLOG-2805), which shipped in v2.29.0;
 * he then ruled **"Listing"** (BACKLOG-2850). That is the current string, and
 * it is what a live user already sees. `sale` has stayed **"Sale"**
 * throughout.
 *
 * DISPLAY ONLY. The keys are the values actually stored in
 * `transactions.transaction_type`, and they do not move: they are a DB column,
 * a Zod enum (electron/schemas/transaction.ts), an LLM tool type and the
 * `create-audit-type-*` e2e selectors. Anything that compares, filters, styles
 * or persists must keep using the key; only what a person reads uses the value.
 *
 * MIRRORED, NOT SHARED. The three export producers in `electron/` cannot
 * import this file — `electron/` may not import from `src/` (rootDir) — so
 * they carry `electron/constants/transactionTypeLabels.ts` instead. Change one
 * and you must change the other. Both sides' suites assert these exact string
 * literals independently, so drift turns the opposite side red rather than
 * shipping two vocabularies for one field.
 *
 * `other` is deliberately absent. It is a valid enum member, but each surface
 * has always had its own answer for it (the details badge says "Other", the
 * cards fall through to "Sale", the exports say "N/A"), and this ticket did
 * not rule on it. Callers keep their existing fallback; see BACKLOG-2805
 * notes for the inconsistency.
 */
export const TRANSACTION_TYPE_LABELS: Record<"purchase" | "sale", string> = {
  purchase: "Listing",
  sale: "Sale",
};
