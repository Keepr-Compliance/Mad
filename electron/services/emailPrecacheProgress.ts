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
 *
 * The fetch rounds interpolate INSIDE those anchors (see
 * `EMAIL_PRECACHE_FETCH_RANGE`), which makes the invariant load-bearing rather
 * than incidental: a round that restarts — `retryOnNetwork` re-runs a whole
 * provider block on a network error, and the round's own counter restarts at
 * zero with it — would otherwise walk the bar backwards. `precacheEmails`
 * enforces the invariant at its single `emitProgress` choke point rather than at
 * each call site, so a round added later cannot forget to.
 */

import type { EmailPrecacheStage } from "../types/ipc/emailPrecacheStage";

export type { EmailPrecacheStage };

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
  /**
   * Which round is downloading. Present only while `phase` is `"fetching"`, and
   * only for rounds that report progress of their own — the boundary events and
   * the backfill sweep carry none, so a surface must be able to render the
   * generic "Downloading emails" without one. See `EmailPrecacheStage`.
   */
  stage?: EmailPrecacheStage;
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
 * SUB-RANGES INSIDE THE FETCH PHASE.
 *
 * The anchors above are the only percents `precacheEmails` used to emit while
 * fetching: 10 before Outlook, 50 between the providers, 90 after Gmail. Three
 * numbers for a phase that is the whole wait. On a large mailbox the bar sat on
 * 10 for the entire Outlook round and on 50 for the entire Gmail round, which is
 * the "it is stuck" the users were reporting — the run was fine, the report was
 * not.
 *
 * Each fetch round now interpolates inside its own slice of the SAME anchors.
 * The anchors themselves are unchanged, so every existing assertion about them
 * still holds: 10 is still the first fetching event, 50 is still the
 * between-providers one, 90 is still the last.
 *
 *   10 ──── Outlook inbox ──── 30 ──── Outlook folders ──── 50
 *   50 ── Gmail scan ── 54 ── Gmail bodies ── 70 ── Gmail labels ── 90
 *
 * The Outlook split is even because the two rounds are comparable in length (the
 * folder walk is usually the longer of the two, which the even split
 * understates — understating is the safe direction: the bar never claims
 * progress it has not made).
 *
 * Gmail's slices are uneven on purpose. `gmailFetchService.searchEmails` lists
 * message IDs first and then downloads one body per ID; the body loop is where
 * nearly all of a Gmail round's time goes, so the ID scan gets a token 4 points
 * and the bodies get 16.
 */
export const EMAIL_PRECACHE_FETCH_RANGE = {
  /** `outlookFetchService.searchEmails` — has a real `@odata.count` to divide by. */
  OUTLOOK_INBOX: { start: EMAIL_PRECACHE_PERCENT.FETCH_START, end: 30 },
  /** `outlookFetchService.searchAllFolders` — driven by folders completed. */
  OUTLOOK_FOLDERS: { start: 30, end: EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER },
  /** Gmail's message-ID listing pass. Bounded by the caller's `maxResults`. */
  GMAIL_SCAN: { start: EMAIL_PRECACHE_PERCENT.FETCH_SECOND_PROVIDER, end: 54 },
  /** Gmail's per-message body downloads — a real count, and the long part. */
  GMAIL_BODIES: { start: 54, end: 70 },
  /** `gmailFetchService.searchAllLabels` — driven by labels completed. */
  GMAIL_LABELS: { start: 70, end: EMAIL_PRECACHE_PERCENT.FETCH_DONE },
} as const;

/**
 * Map a round's own 0..1 completion onto its slice of the anchors.
 *
 * NEVER RETURNS `end`. A round that reports itself 100% done still yields
 * `end - 1`, because `end` is the next anchor and an anchor means "the phase
 * after this one has started". A bar that reads 50 while Outlook is still
 * downloading is the same lie in miniature as a bar that reads 100 while the
 * run is still going — and BACKLOG-2856 already had to fix that one.
 *
 * A non-finite or negative `fraction` yields `start`, so a provider that hands
 * back a nonsense total (a zero denominator is the realistic one) holds the bar
 * where the round began instead of throwing or emitting `NaN` at the renderer.
 */
export function interpolateFetchPercent(
  range: { start: number; end: number },
  fraction: number,
): number {
  const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const span = Math.max(0, range.end - range.start - 1);
  return range.start + Math.floor(span * safe);
}

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
