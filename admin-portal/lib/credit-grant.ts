/**
 * Credit-grant input validation & shaping (BACKLOG-2016).
 *
 * Pure, DOM-free helpers for the support-facing "Grant / claw back credits"
 * flow on the user-detail page. The actual mutation is a call to the
 * `admin_adjust_credits` RPC (BACKLOG-2004), which records an append-only
 * `credit_ledger` `adjustment` row:
 *   - a GRANT     is a positive amount
 *   - a CLAWBACK  is a negative amount
 * The RPC itself rejects a zero amount and requires an internal role; these
 * helpers front-load client-side validation so the operator sees precise field
 * errors before we hit the network.
 *
 * Kept separate from the React component so it can be unit-tested in node
 * (admin-portal tests run under vitest, no jsdom).
 */

/** Which direction the operator selected in the modal. */
export type GrantDirection = 'grant' | 'clawback';

/** Raw operator input from the modal form (all strings, pre-validation). */
export interface GrantInputRaw {
  /** The magnitude the operator typed, as a raw string (always positive). */
  amountRaw: string;
  /** The required justification, verbatim. */
  reason: string;
  /** grant (add credits) | clawback (remove credits). */
  direction: GrantDirection;
}

/** A validated, RPC-ready adjustment. `amount` is already signed. */
export interface GrantInputValid {
  ok: true;
  /** Signed integer: positive for grant, negative for clawback. */
  amount: number;
  /** Trimmed, non-empty reason. */
  reason: string;
}

/** Validation failure with per-field messages for inline display. */
export interface GrantInputInvalid {
  ok: false;
  errors: {
    amount?: string;
    reason?: string;
  };
}

export type GrantValidationResult = GrantInputValid | GrantInputInvalid;

/** Max magnitude for a single adjustment — a guardrail against fat-fingering. */
export const MAX_GRANT_MAGNITUDE = 10000;

/**
 * Validate and shape raw modal input into a signed, RPC-ready adjustment.
 *
 * Rules:
 * - `reason` is REQUIRED (founder rule: every adjustment is auditable). Empty
 *   or whitespace-only is rejected.
 * - `amountRaw` must parse to a positive integer (no zero, no fractions, no
 *   negatives — the sign is derived from `direction`, never typed).
 * - Magnitude is capped at MAX_GRANT_MAGNITUDE.
 * - `direction === 'clawback'` negates the amount.
 */
export function validateGrantInput(input: GrantInputRaw): GrantValidationResult {
  const errors: GrantInputInvalid['errors'] = {};

  const reason = input.reason.trim();
  if (reason.length === 0) {
    errors.reason = 'A reason is required for every credit adjustment.';
  }

  // Reject anything that is not a clean base-10 integer (blocks "1.5", "1e3",
  // "abc", "", " ", "-2"). Number() alone would accept "1.5" and "1e3".
  const trimmedAmount = input.amountRaw.trim();
  let magnitude = NaN;
  if (!/^\d+$/.test(trimmedAmount)) {
    errors.amount = 'Enter a whole number of credits.';
  } else {
    magnitude = parseInt(trimmedAmount, 10);
    if (magnitude === 0) {
      errors.amount = 'Amount must be greater than zero.';
    } else if (magnitude > MAX_GRANT_MAGNITUDE) {
      errors.amount = `Amount cannot exceed ${MAX_GRANT_MAGNITUDE} credits.`;
    }
  }

  if (errors.amount || errors.reason) {
    return { ok: false, errors };
  }

  const amount = input.direction === 'clawback' ? -magnitude : magnitude;
  return { ok: true, amount, reason };
}

/** Human label for a direction, used in the confirm button / summary. */
export function directionVerb(direction: GrantDirection): string {
  return direction === 'clawback' ? 'Claw back' : 'Grant';
}
