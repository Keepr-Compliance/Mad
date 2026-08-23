/**
 * THE COMMUNICATION LIFECYCLE, PUBLISHED (BACKLOG-2818)
 *
 * Where an email or a text thread can live on a transaction, every legal way it
 * moves, and the one string that decides where a restore sends it.
 *
 * Founder question, 2026-08-23: "do we have a published interface for the states
 * or are we using strings?" The answer was "partly" — reviewStateService
 * published its own vocabulary (ReviewOrigin / ReviewKind / PendingSyncReason)
 * but the three LIFECYCLE states were implicit in table membership, and the
 * restore-destination discriminator was a raw literal repeated across service
 * code and a SQL string. This module is the answer: one definition, imported
 * everywhere, with the transition table carried as DATA so the Communication
 * Lifecycle Contract and the code cannot drift apart in silence.
 *
 * BOUNDARY — WHY THIS FILE SITS HERE AND IS NOT IN THE ipc BARREL
 * ---------------------------------------------------------------
 * It lives beside the IPC DTOs because that is how this repo shares review
 * vocabulary: `ReviewKind` / `ReviewItemDto` live in `window-api-transactions.ts`
 * and every renderer consumer reaches them through `import type`, which
 * `isolatedModules` erases, so nothing crosses into the Vite bundle.
 *
 * It is deliberately NOT re-exported from `electron/types/ipc/index.ts`. That
 * barrel is re-exported wholesale by `src/types/index.ts`, and this file carries
 * RUNTIME values (a const and a table), not just types. Barrel membership would
 * leave those values one accidental value-import away from the renderer bundle,
 * where `vite.config.js` (`esbuild.include: /src\/.*\.[tj]sx?$/`) applies the tsx
 * loader only to files under `src/` — an `electron/` file arriving there is
 * parsed as plain JavaScript and the build fails. The repo already draws this
 * line: the other value-bearing files in this directory (`messageChannels.ts`,
 * `window-api-entitlement.ts`, `window-api-pairing.ts`, `window-api-payment.ts`)
 * are likewise unbarrelled.
 *
 * So: main-process code value-imports this file directly. A renderer consumer
 * writes `import type { CommunicationLifecycleState } from
 * "@electron/types/ipc/communicationLifecycle"` and gets an erased import.
 * `npm run build` is the control that proves the line holds.
 *
 * The file imports NOTHING, on purpose — no `electron`, no db, no logging — so
 * it is safe from either side and cheap to import from a test.
 */

/* ------------------------------------------------------------------ *
 * The states
 * ------------------------------------------------------------------ */

/**
 * The three homes a communication can occupy on a transaction.
 *
 *  "suggested"  found by sync, awaiting a decision. Holds the Complete gate
 *               open. Shown on the Needs Review screen, the tabs' needs-review
 *               sections and the header badge.
 *  "linked"     attached to the transaction — counts for audit and export.
 *               Shown in the Emails / Texts tab main lists.
 *  "removed"    excluded by the user. Shown under "Show removed".
 *
 * NOTE ON STORAGE: a state is NOT the same thing as a table. "suggested" is
 * normally a row in the pending-review queue, but the legacy BACKLOG-2319
 * population is physically a link row flagged with the address-missing
 * classification — linked before this contract existed, yet SUGGESTED by it, and
 * counted as such by `getReviewState()`. Derive a state from `getReviewState()`
 * membership, never from which table a row sits in.
 *
 * The stores are named in `reviewStateService`, and deliberately not here: the
 * singleReadPath-2791 guard greps the source tree so that exactly one file names
 * them, and it does not distinguish a doc comment from a query. Naming them here
 * would have meant widening its allow-list, which is the one change that makes
 * a guard stop guarding.
 */
export type CommunicationLifecycleState = "suggested" | "linked" | "removed";

/**
 * Every state, once, as data — for iteration and for the compile-time coverage
 * check below.
 */
export const LIFECYCLE_STATES = ["suggested", "linked", "removed"] as const;

/**
 * Compile-time proof that `LIFECYCLE_STATES` lists every member of the union and
 * nothing else.
 *
 * `Tuple extends readonly Union[]` rejects an EXTRA member; the `Exclude` arm
 * rejects a MISSING one. Add a fourth state to the union without adding it here
 * and `tsc` fails on this line with the missing name in the error text.
 */
type AssertTupleCoversUnion<
  Union extends string,
  Tuple extends readonly Union[],
> = Exclude<Union, Tuple[number]> extends never
  ? true
  : { readonly missingFromLifecycleStates: Exclude<Union, Tuple[number]> };

const _LIFECYCLE_STATES_COVER_THE_UNION: AssertTupleCoversUnion<
  CommunicationLifecycleState,
  typeof LIFECYCLE_STATES
> = true;
void _LIFECYCLE_STATES_COVER_THE_UNION;

/**
 * The never-check every switch over the union should end on.
 *
 * Adding a fourth state makes each such `default:` a compile error naming the
 * unhandled member, which is the whole point of publishing the union rather
 * than passing strings around.
 */
export function assertNeverLifecycleState(state: never): never {
  throw new Error(`Unhandled communication lifecycle state: ${String(state)}`);
}

/**
 * Does a communication in this state hold the Complete gate open?
 *
 * The single fact that is true of a state REGARDLESS of which store the row is
 * in: the gate reads `getReviewState().count`, which unions both origins, so a
 * legacy store-B item blocks Complete exactly as a queued one does. Deliberately
 * the only predicate published here — "counts for audit" would have been a
 * half-truth for that same legacy population.
 *
 * Pinned against shipped behaviour by `communicationLifecycle-2818.test.ts`,
 * which drives the real operations and checks the real count.
 */
export function blocksComplete(state: CommunicationLifecycleState): boolean {
  switch (state) {
    case "suggested":
      return true;
    case "linked":
    case "removed":
      return false;
    default:
      return assertNeverLifecycleState(state);
  }
}

/* ------------------------------------------------------------------ *
 * The removal-reason discriminator
 * ------------------------------------------------------------------ */

/**
 * THE discriminator on `ignored_communications.reason`.
 *
 * A removal has two flavours wearing the same face in "Show removed": an
 * ordinary removal, and a REVIEW REJECTION. Only this value marks the second,
 * and the flavour decides where Restore sends the item — a review rejection goes
 * back to SUGGESTED (T6), because it was never approved; an ordinary removal
 * re-links (T7).
 *
 * THIS STRING IS A PERSISTED-DATA CONTRACT, NOT AN INTERNAL NAME. Rows carrying
 * it are already on users' disks, written by shipped versions. Changing the
 * value would silently reclassify every one of them as an ordinary removal and
 * hand the user a one-click path from "rejected, never linked" to "linked, never
 * approved". That is why the literal is pinned by tests OUTSIDE this constant:
 * `communicationLifecycle-2818.test.ts` asserts the value, and the restore
 * suites insert shipped-style rows with the raw literal. Change the constant and
 * they go red together.
 */
export const REVIEW_REJECTION_REASON = "rejected_in_review";

/**
 * The legacy needs-review classification, carried on a link row and preserved
 * across a removal so a restore returns the email to the right section.
 *
 * SCOPE NOTE: published because the lifecycle needs it to tell T7 from T7b, and
 * for no wider purpose. BACKLOG-2818 deliberately does NOT sweep this value's
 * other call sites — autoLinkService writes it, the tab components classify on
 * it to render the existing needs-review sections, and singleReadPath-2791
 * governs which files may SELECT on it. That sweep is a separate task with a
 * different blast radius.
 */
export const LEGACY_NEEDS_REVIEW_CLASSIFICATION = "address_missing";

/**
 * The flavours of REMOVED.
 *
 * A removal's flavour decides where Restore sends it, so the flavour is part of
 * a transition's IDENTITY when REMOVED is the source — which is exactly how the
 * contract writes it, qualifying only its From column ("REMOVED (review flavor)",
 * "REMOVED (ordinary flavor)"), never its To column.
 *
 *  "review-rejection"          rejected on a review card. Restore -> SUGGESTED,
 *                              because it was never approved (T6).
 *  "ordinary"                  an everyday removal of a confidently-linked
 *                              communication. Restore -> LINKED (T7).
 *  "ordinary-address-missing"  an everyday removal that CARRIED the legacy
 *                              needs-review classification — a legacy item
 *                              trashed from the tab. Restore returns it to the
 *                              needs-review population, i.e. SUGGESTED (T7b).
 *                              Founder ruling, 2026-08-23.
 */
export type RemovalFlavor = "review-rejection" | "ordinary" | "ordinary-address-missing";

/**
 * Which flavour a suppression row carries.
 *
 * Reason wins over classification, matching `restoreRejectedToQueue`, which
 * checks the reason first: a review rejection ALSO carries the legacy
 * classification (deliberately — it is what keeps a restored rejection out of
 * the linked set), so testing the classification first would misread every
 * rejection as T7b.
 */
export function classifyRemoval(
  reason: string | null,
  matchReason: string | null,
): RemovalFlavor {
  if (reason === REVIEW_REJECTION_REASON) return "review-rejection";
  if (matchReason === LEGACY_NEEDS_REVIEW_CLASSIFICATION) return "ordinary-address-missing";
  return "ordinary";
}

/* ------------------------------------------------------------------ *
 * The transition table — T1..T7b of the Communication Lifecycle Contract
 * ------------------------------------------------------------------ */

/** A transition's origin. `"new"` is the contract's "(new)" — discovery. */
export type LifecycleFrom = CommunicationLifecycleState | "new";

export type LifecycleTransitionId =
  | "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T7b";

export interface LifecycleTransition {
  /** The contract's row number, so a failure names the row a reader can look up. */
  readonly id: LifecycleTransitionId;
  readonly from: LifecycleFrom;
  readonly to: CommunicationLifecycleState;
  /** What the user (or the sync) does to cause it — the contract's Trigger column. */
  readonly actions: readonly string[];
  /**
   * The removal flavour this row concerns.
   *
   * When `from` is "removed" it is part of the row's IDENTITY — the flavour is
   * the INPUT that selects the destination, which is why three rows (T6, T7,
   * T7b) share a source state and differ only here, and why
   * `lifecycleTransitionKey` folds it in for exactly those rows.
   *
   * When `to` is "removed" it is DOCUMENTATION of the flavour the transition
   * writes. It is deliberately NOT part of the key there: the contract qualifies
   * only its From column, and a legacy item trashed from the tab is the same
   * SUGGESTED -> REMOVED move as T4 while writing a different flavour.
   */
  readonly removalFlavor?: RemovalFlavor;
}

/**
 * Every legal move, as data.
 *
 * Transcribed row-for-row from the Communication Lifecycle Contract
 * (BACKLOG-2791, "Every transition"). `communicationLifecycle-2818.test.ts`
 * drives the REAL operations and compares observed from->to pairs against this
 * table as SETS IN BOTH DIRECTIONS: a pair the code performs that is missing
 * here is code drift; a row here that no operation performs is contract drift.
 * Neither can pass silently.
 */
export const LIFECYCLE_TRANSITIONS: readonly LifecycleTransition[] = [
  {
    id: "T1",
    from: "new",
    to: "linked",
    // Two doors, per the contract: the sync's confident half, and a manual attach.
    actions: ["sync-confident-split", "manual-attach"],
  },
  {
    id: "T2",
    from: "new",
    to: "suggested",
    actions: ["sync-address-missing"],
  },
  {
    id: "T3",
    from: "suggested",
    to: "linked",
    actions: ["review-confirm"],
  },
  {
    id: "T4",
    from: "suggested",
    to: "removed",
    actions: ["review-trash"],
    removalFlavor: "review-rejection",
  },
  {
    id: "T5",
    from: "linked",
    to: "removed",
    actions: ["linked-card-trash"],
    removalFlavor: "ordinary",
  },
  {
    id: "T6",
    from: "removed",
    to: "suggested",
    actions: ["removed-card-restore"],
    removalFlavor: "review-rejection",
  },
  {
    id: "T7",
    from: "removed",
    to: "linked",
    actions: ["removed-card-restore"],
    removalFlavor: "ordinary",
  },
  {
    // FOUNDER RULING, 2026-08-23. Raised from this task's own finding: an
    // ordinary removal that carried the legacy needs-review classification does
    // NOT restore to LINKED. The shipped restore preserves the classification,
    // so the recreated link lands back in the needs-review population, which
    // getReviewState counts — SUGGESTED, not LINKED. The contract page carries
    // it as T7b and so does this table; without it the behaviour was real,
    // published nowhere, and enforced by nothing.
    id: "T7b",
    from: "removed",
    to: "suggested",
    actions: ["removed-card-restore"],
    removalFlavor: "ordinary-address-missing",
  },
];

/**
 * The key both directions of the exhaustiveness comparison are made on.
 *
 * `from->to`, with the removal flavour folded into the SOURCE when the source is
 * REMOVED: `removed(ordinary)->linked`. That is where the contract itself puts
 * it, qualifying only its From column — and it is the only place a test can
 * honestly observe it, by classifying the suppression row the item occupied
 * before the operation ran.
 *
 * Folding it in matters: T6, T7 and T7b all leave REMOVED, so on a bare
 * `from->to` pair T7b would collide with T6 and could be deleted from the table
 * without a single test noticing.
 */
export function lifecycleTransitionKey(
  from: LifecycleFrom,
  to: CommunicationLifecycleState,
  removalFlavor?: RemovalFlavor,
): string {
  const source = from === "removed" && removalFlavor ? `${from}(${removalFlavor})` : from;
  return `${source}->${to}`;
}

/** Every published key. Derived, so deleting a row shrinks this set. */
export const PUBLISHED_TRANSITION_KEYS: ReadonlySet<string> = new Set(
  LIFECYCLE_TRANSITIONS.map((t) => lifecycleTransitionKey(t.from, t.to, t.removalFlavor)),
);

/** Is this move one the contract allows? */
export function isPublishedTransition(
  from: LifecycleFrom,
  to: CommunicationLifecycleState,
  removalFlavor?: RemovalFlavor,
): boolean {
  return PUBLISHED_TRANSITION_KEYS.has(lifecycleTransitionKey(from, to, removalFlavor));
}

/** The contract rows that describe a given move, for naming a failure. */
export function transitionsFor(
  from: LifecycleFrom,
  to: CommunicationLifecycleState,
  removalFlavor?: RemovalFlavor,
): readonly LifecycleTransition[] {
  return LIFECYCLE_TRANSITIONS.filter(
    (t) =>
      lifecycleTransitionKey(t.from, t.to, t.removalFlavor) ===
      lifecycleTransitionKey(from, to, removalFlavor),
  );
}
