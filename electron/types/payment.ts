// ============================================
// PAYMENT TYPES (BACKLOG-2015 — desktop PAYG card-purchase flow, 2005b)
//
// Fills the zero-balance card path the entitlement stack (2006a) and the
// ExportUnlockPrompt (2075) hand off to. The MAIN process owns every money /
// JWT / portal call; the renderer only renders states and fires intent.
//
// FAIL-CLOSED (shared with the entitlement stack): a portal 200 NEVER unlocks a
// transaction on its own. `onUnlocked` fires only after the authoritative
// `transaction_unlocks` gate is re-read as "unlocked" (entitlementService).
// Nothing here relaxes that gate.
// ============================================

/**
 * Result of starting the FIRST-purchase Checkout flow (Flow A).
 * On success the MAIN process has already opened the Checkout URL in the system
 * browser; the renderer waits for the `payment:deep-link-callback` event, then
 * calls `confirm`.
 */
export interface BeginCheckoutResult {
  /** true when the Checkout URL was created AND opened in the external browser. */
  started: boolean;
  /**
   * Why it could not start (diagnostic; drives the CTA). Present only when
   * started === false. "offline" | "unauthenticated" | "no_quote" | "error".
   */
  error?: string;
}

/**
 * Result of a subsequent one-click off-session charge (Flow B).
 *
 * Discriminated on `outcome`:
 *  - "succeeded"           — the off-session charge went through (or is
 *                            processing); the caller confirms via the gate re-read.
 *  - "requires_action"     — SCA/3DS. If `redirectUrl` is non-null the MAIN
 *                            process opened it externally (returns via the deep
 *                            link). If `redirectUrl` is null (the merged /charge
 *                            can return this — no return_url on the PI), the
 *                            caller MUST fall back to Flow A Checkout (which
 *                            handles 3DS itself). No double-charge: the failed
 *                            off-session PI never confirmed and the idempotency
 *                            prefixes differ (pi: vs co:). See BACKLOG-2083.
 *  - "declined"            — hard decline (card_declined, insufficient_funds…).
 *  - "invalid_payment_method" — BACKLOG-2088: the saved card is unusable
 *                            (detached / deleted / not attached). Stripe rejects
 *                            it at PI creation (no charge attempted). The portal
 *                            has cleared the stale saved-card cache; the caller
 *                            shows "add a new card" and routes to Flow A Checkout.
 *  - "no_saved_card"       — 409: no saved card ⇒ the caller runs Flow A.
 *  - "offline"             — no network; nothing was charged.
 *  - "error"               — unexpected failure; nothing was charged.
 */
export type ChargeOutcome =
  | "succeeded"
  | "requires_action"
  | "declined"
  | "invalid_payment_method"
  | "no_saved_card"
  | "offline"
  | "error";

export interface ChargeResult {
  outcome: ChargeOutcome;
  /**
   * SCA hosted-confirmation URL. `string` when Stripe supplied one (MAIN already
   * opened it externally); `null` when Stripe required action but gave no URL —
   * the caller falls back to Flow A. Only meaningful for "requires_action".
   */
  redirectUrl?: string | null;
  /** Machine-readable decline code (e.g. "card_declined"). Only for "declined". */
  code?: string;
  /** Human-readable message for the decline branch (diagnostic/CTA copy). */
  message?: string;
}

/**
 * Result of confirming a purchase after the Checkout / SCA return. This is the
 * ONLY unlock authority on the desktop side: it polls the portal /status
 * (session-keyed) and/or re-reads the authoritative `transaction_unlocks` gate,
 * and returns `unlocked: true` ONLY on a positive gate confirmation.
 */
export interface PaymentConfirmResult {
  /** true ONLY when the authoritative entitlement gate re-read says "unlocked". */
  unlocked: boolean;
  /** Diagnostic when not unlocked: "timeout" | "offline" | "unauthenticated" | "error". */
  reason?: string;
}

/**
 * Whether the user has a saved card (Flow B eligibility). A pure OPTIMIZATION —
 * the portal /charge 409 remains the authority on saved-card truth, so this is
 * re-checked per purchase intent, never cached across a session (a card may be
 * saved mid-session by a first purchase). RLS-scoped read of stripe_customers.
 */
export interface SavedCardStatus {
  hasSavedCard: boolean;
}
