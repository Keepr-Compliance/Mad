// ============================================
// ENTITLEMENT TYPES (BACKLOG-2006a)
// Per-transaction paywall entitlement contract.
//
// DESIGN PRINCIPLE: FAIL-CLOSED. Unlike the org-plan FeatureGate stack
// (which is fail-OPEN), the paywall defaults to LOCKED and only resolves
// UNLOCKED on a POSITIVE confirmation (a live, non-refunded server unlock
// row, or a cached mirror of a previously-confirmed server unlock read
// while offline). Any error / loading / offline-uncached state resolves
// LOCKED. There is no code path where absence of information reveals content.
// ============================================

/**
 * The resolved lock state for a single transaction.
 * - "locked":   default. No confirmed entitlement — content must stay behind the shield.
 * - "unlocked": positively confirmed (server row present, refunded_at IS NULL,
 *               or an offline cache mirror of such a row).
 */
export type UnlockStatus = "locked" | "unlocked";

/**
 * Why a transaction resolved LOCKED (diagnostic only; NEVER used to relax the gate).
 * Consumers may use this to shape the CTA (e.g. "online required" when offline &
 * uncached), but every value here still renders the shield.
 */
export type LockReason =
  | "no_unlock" // online, checked server, no (non-refunded) unlock row exists
  | "refunded" // an unlock row exists but was refunded — treated as locked
  | "offline_uncached" // offline and no cached prior unlock — cannot verify, stay locked
  | "error" // any failure resolving entitlement — fail closed
  | "not_authenticated"; // no auth session — cannot verify ownership, stay locked

/**
 * Live pay-as-you-go quote for unlocking a transaction, sourced from
 * get_next_unlock_quote. Drives the paid-path CTA label. Null when it
 * cannot be fetched (offline / error) — the UI must degrade to an
 * "online required to unlock" state, never to a free unlock.
 */
export interface UnlockQuote {
  /** "your Nth PAID deal this year" — grants do NOT advance this index. */
  nextUnitIndex: number;
  unitPriceCents: number;
  currency: string;
  pricingTierId: string | null;

  // ── Tier-progress fields (BACKLOG-2086) ──────────────────────────────────
  // Read-only surfacing of the descending calendar-year PAYG ladder so the
  // credit-first paywall can render a "N more unlocks and every deal drops to
  // the next tier" incentive bar WITHOUT re-deriving the ladder. All four are
  // OPTIONAL for back-compat and resolve to null/undefined on the open-ended
  // top band (already at the best price). NONE of these affect the charge — the
  // authoritative price remains unitPriceCents.

  /** max_units of the user's CURRENT band; null on the open-ended top band. */
  currentBandMaxUnits?: number | null;
  /**
   * Unlocks remaining at the CURRENT price before the per-deal cost drops
   * (includes the deal being priced now: currentBandMaxUnits - paidCount).
   * null on the top band. Treat <= 0 defensively.
   */
  unitsUntilNextBand?: number | null;
  /** Unit price (cents) of the NEXT, cheaper band; null on the top band. */
  nextBandUnitPriceCents?: number | null;
  /** Currency of the next band; null on the top band. */
  nextBandCurrency?: string | null;
}

/**
 * The full entitlement snapshot for one transaction, returned to the renderer.
 * Everything the paywall UI (2006b) needs to render the locked/unlocked state
 * and the correct CTA, without ever needing to make the gate decision itself.
 */
export interface EntitlementStatus {
  localTransactionId: string;
  /** THE gate decision. Defaults to "locked". */
  status: UnlockStatus;
  /** Present only when status === "locked" (diagnostic; still locked regardless). */
  lockReason?: LockReason;
  /** True when the resolution was served from the offline cache (no server contact). */
  fromCache: boolean;
  /** Live PAYG quote for the paid unlock path. Null when unavailable (offline/error). */
  quote: UnlockQuote | null;
  /** Grant-credit balance. Credits spend BEFORE card. 0 or null when unavailable. */
  creditBalance: number | null;
}

/**
 * Result of an unlock attempt via the grant-credit path (unlock_transaction).
 */
export interface UnlockResult {
  success: boolean;
  status: UnlockStatus;
  /** Machine-readable failure reason, e.g. "offline", "no_credit", "error". */
  error?: string;
}

/**
 * Export gating decision surfaced by the entitlement service for the
 * main-process export handlers. This is the authoritative, non-bypassable gate.
 *
 * BACKLOG-2075 (Option A): reading is FREE everywhere; only the EXPORT is gated.
 * There is no free/sample export — a transaction is either UNLOCKED ("full") or
 * blocked ("none"). The old "sample" mode (1 email + 1 text teaser export) was
 * removed with the read-paywall deferral to BACKLOG-2079.
 */
export interface ExportEntitlementDecision {
  /** Whether ANY export may proceed at all. */
  allowed: boolean;
  /**
   * "full" — the transaction is unlocked; export the complete record.
   * "none" — locked: nothing may be exported (the renderer routes to the
   *          unlock CTA on the resulting PAYWALL_LOCKED error).
   */
  mode: "full" | "none";
  /** Diagnostic reason when allowed === false (mode "none"). */
  reason?: LockReason;
}

/** Analytics event names emitted by BACKLOG-2006a into analytics_events. */
export const PAYWALL_ANALYTICS_EVENTS = {
  PAYWALL_VIEWED: "paywall-viewed",
  EXPORT_COMPLETED: "export-completed",
  /** BACKLOG-2015: emitted when a user initiates a paid unlock (Checkout or one-click charge). */
  UNLOCK_CLICKED: "unlock-clicked",
} as const;

/** Typed error thrown by the export handlers when a locked tx is exported. */
export const PAYWALL_LOCKED_ERROR = "PAYWALL_LOCKED" as const;
