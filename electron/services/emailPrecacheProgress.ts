/**
 * Progress reporting for the email pre-cache / re-cache run (BACKLOG-2856).
 *
 * WHY A SEPARATE TYPE FROM THE MESSAGES IMPORT
 * --------------------------------------------
 * The field shape is deliberately identical to `ImportProgressCallback`
 * (macOSMessagesImportService/types.ts) — same `current` / `total` / `percent`
 * triple, same "callback threaded through the service, forwarded to the renderer
 * by the handler" transport — because the founder's requirement for this item is
 * parity with the messages Force Re-import and the UI should behave the same.
 *
 * The PHASE UNION is not shared, and widening the messages one would have been
 * the wrong kind of reuse: `deleting` and `attachments` describe nothing an email
 * run does, and adding `repairing` / `swapping` to the messages union would leak
 * email-only states into every message-typed consumer, where they are
 * unreachable. Same shape, same transport, own vocabulary.
 *
 * THE TWO PATHS HAVE DIFFERENT SEQUENCES, NOT ONE SEQUENCE WITH OPTIONAL PHASES
 * ----------------------------------------------------------------------------
 * An ordinary re-cache repairs then fetches. A force re-cache never repairs
 * (`emailSyncService`: the repair pass is skipped on force, because every row it
 * would touch is about to be deleted and re-fetched, and it writes LIVE) and
 * ends with a swap the ordinary path does not have:
 *
 *   ordinary:  repairing -> fetching -> done
 *   force:                  fetching -> swapping -> done
 *
 * PERCENT IS MONOTONICALLY NON-DECREASING
 * ---------------------------------------
 * The anchors are the ones `precacheEmails` has emitted since BACKLOG-1362
 * (10 / 50 / 90 / 100), now carrying a phase label. During the repair pass
 * `percent` holds at REPAIRING while `current` climbs, so the bar does not
 * stall silently but also never goes backwards when fetching starts.
 */

/** The channel the main process pushes progress over. Renderer subscribes via
 *  `window.api.transactions.onPrecacheProgress`. */
export const EMAIL_PRECACHE_PROGRESS_CHANNEL = "emails:precache-progress";

export type EmailPrecachePhase =
  /** BACKLOG-2857 derivation repair. Ordinary path only — never emitted on force. */
  | "repairing"
  /** Fetching + storing from each connected provider. */
  | "fetching"
  /** Force path only: the staging -> live swap. */
  | "swapping"
  /** Terminal. Always carries an `outcome`; always the last event of a run. */
  | "done";

/**
 * Why the run stopped. Present ONLY on the terminal (`phase: "done"`) event.
 *
 * `cancelled` is not folded into `error`: the user asked for it, so the panel
 * must not paint it red, and `percent` must not claim 100 for work that did not
 * happen.
 */
export type EmailPrecacheOutcome = "success" | "error" | "cancelled";

export interface EmailPrecacheProgress {
  phase: EmailPrecachePhase;
  current: number;
  total: number;
  percent: number;
  outcome?: EmailPrecacheOutcome;
}

export type EmailPrecacheProgressCallback = (progress: EmailPrecacheProgress) => void;

/**
 * Percent anchors, named so the service and its tests cannot drift apart.
 *
 * REPAIRING sits below FETCH_START so the repair pass — the dead time this
 * change exists to make visible on the ordinary path — is always reported
 * before anything fetch-related, and never above it.
 */
export const EMAIL_PRECACHE_PERCENT = {
  REPAIRING: 5,
  FETCH_START: 10,
  FETCH_SECOND_PROVIDER: 50,
  FETCH_DONE: 90,
  SWAPPING: 95,
  DONE: 100,
} as const;

/**
 * Build the terminal event.
 *
 * Centralised because "the bar is stranded at 40%" is the failure mode of every
 * exit path that forgets one, and a stranded bar after a CANCEL is the same
 * defect as a stranded bar after a throw.
 *
 * `percent` reaches 100 only on success. An error or a cancel reports the last
 * percent the run actually got to — filling the bar for work that did not happen
 * would be the same class of lie as the green "Re-cached 47 emails" this item
 * already had to fix. The renderer settles on `phase === "done"`, never on
 * reaching 100, so an honest sub-100 terminal still dismisses the bar.
 */
export function terminalProgress(
  outcome: EmailPrecacheOutcome,
  current = 0,
  lastPercent = 0,
): EmailPrecacheProgress {
  return {
    phase: "done",
    current,
    total: current,
    percent: outcome === "success" ? EMAIL_PRECACHE_PERCENT.DONE : lastPercent,
    outcome,
  };
}
