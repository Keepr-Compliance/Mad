/**
 * Wall-clock instrument for the email pre-cache / re-cache run (BACKLOG-2960).
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * BACKLOG-2960 converts the data layer's interface to promise-returning
 * functions, and the founder's acceptance bound for that conversion is
 * "no more than 3% wall-clock on a full re-cache". Before this module there was
 * NO duration on the pre-cache path — the run logged what it fetched and what it
 * stored, and how long it took was recoverable only by subtracting two log
 * timestamps by eye, across a run that emits dozens of lines. A 3% bound cannot
 * be argued from that, so the instrument ships FIRST, on its own, against
 * unconverted code. A before/after comparison whose "before" was measured with a
 * different instrument is not a comparison.
 *
 * THIS MODULE IS PURE ON PURPOSE — IT IMPORTS NOTHING
 * --------------------------------------------------
 * No `electron`, no `logService`, no Sentry. It formats a record into a string.
 * That keeps it trivially unit-testable without a driver or a running app, and
 * it keeps BACKLOG-2961 (which measures module-level Electron coupling) from
 * gaining a new coupled module because of a timing line. The caller
 * (`emailSyncService.precacheEmails`) owns the clock, the log transport and the
 * build lookup; this module owns the SHAPE, which is the part that has to stay
 * stable across the conversion for the two numbers to be comparable.
 *
 * ONE LINE, ONE TAG, EVERY FIELD IN THE MESSAGE
 * ---------------------------------------------
 * The founder reads this by grepping one tag out of a large log file, so every
 * field is in the message text rather than only in the structured metadata —
 * the same choice `[CACHE-HITMISS]` in `emailSyncService` already made, and for
 * the same reason: metadata rendering depends on the transport, a message does
 * not. The structured metadata is emitted too, for anything that parses.
 */

/**
 * The grep tag. One run emits exactly one line carrying it — asserted, because
 * "how long did the re-cache take" is unanswerable if the answer appears twice
 * with different numbers.
 */
export const EMAIL_PRECACHE_TIMING_TAG = "[PRECACHE-TIMING]";

/**
 * What kind of run this was.
 *
 * - `force`    — the user pressed Force Re-cache: the whole cache window is
 *                re-downloaded and swapped in. THIS is the mode the 3% bound is
 *                stated against (33,637 emails).
 * - `re-cache` — an ordinary incremental run over a cache that already held
 *                mail: repair pass, then newer-mail-plus-any-widened-gap.
 * - `cache`    — an ordinary run with no cached mail to work from (first fill
 *                after onboarding).
 *
 * `cache` vs `re-cache` is decided by the SAME expression the existing
 * "Email pre-cache date range computed" line reports as `isIncremental`
 * (`cachedBounds?.newest`), so the two lines can never disagree about which run
 * this was.
 */
export type EmailPrecacheMode = "cache" | "re-cache" | "force";

/**
 * How the run ended. Reused from the progress channel's vocabulary rather than
 * redefined, because a timing line and a progress bar disagreeing about whether
 * a run succeeded would be worse than either being absent.
 *
 * Carried on the line — NOT in the brief's field list, added deliberately —
 * because a cancelled run and a run that threw both produce an `elapsedMs`, and
 * without the outcome those are indistinguishable from a completed baseline. A
 * before/after comparison must only ever use `outcome=success` lines.
 */
export type EmailPrecacheTimingOutcome = "success" | "error" | "cancelled";

export interface EmailPrecacheTimingRecord {
  mode: EmailPrecacheMode;
  outcome: EmailPrecacheTimingOutcome;
  /** Providers this run could rebuild, from the connected mailbox tokens. */
  providers: readonly string[];
  /** Emails CHECKED — the provider rows this run pulled down. Matches the
   *  "(N checked)" the Settings panel prints (`emailsFetched`). */
  checked: number;
  /** Emails WRITTEN — rows this run inserted. On a force run these land in
   *  staging; `inserted` below is what survived the swap into live. */
  written: number;
  /** Force runs only: rows the staging→live swap actually inserted. Omitted
   *  entirely on ordinary runs and on a force run that never reached the swap,
   *  because printing `inserted=0` there would read as "the swap ran and
   *  inserted nothing" rather than "no swap happened". */
  inserted?: number;
  /** Wall-clock milliseconds for the WHOLE run: method entry to exit, across
   *  every provider and the swap — not one batch, not one provider. */
  elapsedMs: number;
  /** App version, or "unknown" when it cannot be read (tests, pre-init). The
   *  build the number belongs to; a duration without one cannot be compared. */
  build: string;
  /** Milliseconds this run spent INSIDE the database — the summed time of the
   *  driver calls the run made, across the conduits and the raw-handle holders
   *  alike, over the same span `elapsedMs` covers.
   *
   *  Present because `elapsedMs` alone cannot carry the acceptance bound: the
   *  run is dominated by network fetch, which is what varies (40% spread across
   *  four identical force re-caches — pm_comments `ac7a6f40`), while the
   *  promise-conversion changes the data layer. This is the figure the bound is
   *  meant to apply to.
   *
   *  Process-wide accounting, not run-scoped: any other main-process database
   *  work overlapping the span is included. A comparison run wants the app
   *  otherwise idle. */
  dbMs: number;
}

/**
 * Render the record as one greppable line.
 *
 * Format is `key=value` pairs separated by single spaces, values free of spaces,
 * so `grep '\[PRECACHE-TIMING\]'` piped into `awk` works without quoting rules.
 * Providers join with `+` rather than `,` so the whole line stays comma-free and
 * can be pasted into a spreadsheet as one cell.
 */
export function formatEmailPrecacheTimingLine(
  record: EmailPrecacheTimingRecord,
): string {
  const providers =
    record.providers.length > 0 ? [...record.providers].join("+") : "none";

  const parts = [
    EMAIL_PRECACHE_TIMING_TAG,
    `mode=${record.mode}`,
    `outcome=${record.outcome}`,
    `providers=${providers}`,
    `checked=${record.checked}`,
    `written=${record.written}`,
    // Omitted, not zeroed — see the field doc above.
    ...(record.inserted === undefined ? [] : [`inserted=${record.inserted}`]),
    `elapsedMs=${record.elapsedMs}`,
    `build=${record.build}`,
    // APPENDED, never inserted. The founder reads this line by grepping the tag
    // and cutting fields positionally; putting a new field anywhere but the end
    // would shift every field after it and silently break notes already taken
    // against earlier runs.
    `dbMs=${record.dbMs}`,
  ];

  return parts.join(" ");
}
