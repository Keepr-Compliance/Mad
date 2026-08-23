/**
 * Export Plan Resolver — BACKLOG-2771
 *
 * ONE decider for what every export format includes.
 *
 * Before this module there were three independent include-set implementations:
 *
 *   1. `transactionExportHandlers.ts` (folder export) — an inline date filter
 *      and an inline content-type filter.
 *   2. `enhancedExportService.ts` (pdf / csv / excel / json / txt_eml) — a
 *      private `_filterCommunicationsByDate` and `_filterByContentType` that
 *      the BACKLOG-2343 comment itself described as "mirroring the
 *      folder-export handler".
 *   3. `transactions:export-pdf` — no filtering at all.
 *
 * The BACKLOG-2343 timezone fix had to be applied to copies (1) and (2)
 * separately, and even after that they still disagreed (`||` vs `??` on the
 * sent_at/received_at fallback — see `communicationDate` below). Copy (3) was
 * never given a filter at all. Attachment selection had the same shape: the
 * folder exporter and the enhanced PDF exporter each re-derived "which
 * communications' attachments do we write", which is exactly how BACKLOG-2769
 * happened — the per-thread email attachment phase carried no reference to the
 * selector and wrote (and downloaded) attachments the user had declined.
 *
 * Everything an export format is allowed to decide about its include set now
 * lives here. A caller states WHAT IT WANTS (`ExportPlanRequest`) and receives
 * WHAT IT GETS (`ExportPlan`). No entry point filters on its own.
 *
 * ## Scope: this resolver decides the SET, not the ORDER.
 *
 * The two renderers order communications differently and their exported
 * artifacts encode that order (folder export sorts ascending per section; the
 * enhanced export sorts descending; `exportAttachments()` writes a
 * `sourceEmailIndex` derived from array position into manifest.json). Changing
 * ordering would change observable output, so ordering stays with the
 * renderers. Use `orderAttachmentComms()` to re-apply a renderer's own order to
 * the plan's selection without re-deriving the selection itself.
 */

import type { Communication } from "../types/models";
import { isEmailMessage, isTextMessage } from "../utils/channelHelpers";
import type {
  ExportAttachmentType,
  ExportContentType,
  ExportEmailMode,
  ExportPlanFormat,
} from "../types/ipc/window-api-transactions";

export type {
  ExportAttachmentType,
  ExportContentType,
  ExportEmailMode,
  ExportPlanFormat,
} from "../types/ipc/window-api-transactions";

/**
 * What a caller asks the resolver for.
 *
 * `startDate`/`endDate` are the audit window. Each entry point supplies its own
 * (folder export uses the transaction's started_at/closed_at; the enhanced
 * export prefers explicit option dates and falls back to the transaction's;
 * the orphan `transactions:export-pdf` channel supplies neither, which is why
 * it exports the whole record). That per-entry-point difference is legitimate
 * and lives in the REQUEST — it is not a reason to have three filters.
 */
export interface ExportPlanRequest {
  format: ExportPlanFormat;
  contentType: ExportContentType;
  attachmentType: ExportAttachmentType;
  emailMode: ExportEmailMode;
  startDate?: string | null;
  endDate?: string | null;
  /**
   * "Summary + indexes only" (the ExportModal's "pdf" format). A summary-only
   * artifact never writes attachment files, regardless of the attachment
   * selection — preserved from `enhancedExportService._exportPDF`, which gated
   * on `!summaryOnly && attachmentType !== "none"`.
   */
  summaryOnly?: boolean;
}

/** What the caller gets. Every export format renders from exactly this. */
export interface ExportPlan {
  /** The communications this export includes, in the caller's input order. */
  communications: Communication[];
  /**
   * The subset whose attachments this export writes to disk. Empty whenever
   * `writesAttachmentsToDisk` is false, so a renderer that iterates this list
   * cannot write a declined attachment even if it forgets the flag.
   */
  attachmentComms: Communication[];
  /** Whether emails render grouped by thread or one file per message. */
  emailRenderMode: ExportEmailMode;
  /**
   * The single gate for every phase that writes an attachment file to disk OR
   * fetches one from the provider (BACKLOG-2769). False => zero file writes and
   * zero downloads.
   */
  writesAttachmentsToDisk: boolean;
  /** Whether the export includes emails at all (drives folder creation). */
  includeEmails: boolean;
  /** Whether the export includes texts at all (drives folder creation). */
  includeTexts: boolean;
}

/**
 * Formats that can write attachment FILES. csv/excel/json/txt_eml record
 * attachment METADATA (`has_attachments`, `attachment_count`, an
 * `X-Attachments` header) but never copy a file or hit the provider, so an
 * attachment selection is meaningless for them.
 */
const ATTACHMENT_CAPABLE_FORMATS: ReadonlySet<ExportPlanFormat> = new Set<ExportPlanFormat>([
  "folder",
  "pdf",
]);

/**
 * The date a communication is filtered on.
 *
 * BACKLOG-2771 — resolving the `||` vs `??` divergence between the two deleted
 * copies. The folder handler used `comm.sent_at || comm.received_at`; the
 * enhanced service used `comm.sent_at ?? comm.received_at` while its own
 * comment claimed "parity with the folder-export handler". `||` is the pinned
 * semantics:
 *
 *   - For `null` and `undefined` the two operators are IDENTICAL, and those are
 *     the only missing-value shapes the producers can emit today (see the test
 *     for the writer-level evidence). The divergence is therefore LATENT, not
 *     live — this is a choice of which semantics to pin, not a behavior change.
 *   - They diverge only on `""`. There, `??` yields `""`, `new Date("")` is an
 *     Invalid Date, and BOTH boundary comparisons (`< start`, `> end`) are
 *     false — so the message is admitted no matter what the audit window says.
 *     A date-scoped audit export silently including an out-of-window message is
 *     the opposite of what this filter exists to do.
 *   - `||` treats `""` as "missing" and falls back to received_at, which is the
 *     stated intent of the BACKLOG-2343 comment that shipped on the `??` copy.
 */
function communicationDate(comm: Communication): Date {
  return new Date((comm.sent_at || comm.received_at) as string);
}

/**
 * The inclusive END of a transaction's audit window: the LAST INSTANT of the
 * audit-end calendar day (`closed_at`), in the user's LOCAL timezone.
 *
 * ## The contract (BACKLOG-2788, founder decision 2026-08-22)
 *
 * > "think about it from the agent's perspective, they work in their local
 * > time, so we need to show the transaction from their eyes."
 *
 * The closing day ends at the AGENT'S LOCAL midnight — the same instant the
 * Texts tab already treats as the end of the audit period. This is the ONE
 * place that decides it; every other closing-day bound derives from here.
 *
 * Returned value: local `23:59:59.999` on the audit-end day, i.e. the last
 * millisecond before local midnight. Callers use it INCLUSIVELY — the export
 * excludes on `commDate > end`, the SQL sites bind `<= end.toISOString()` —
 * so a communication stamped exactly at local midnight belongs to the NEXT
 * day and is out, which is what "the day ends at midnight" means and what
 * `isTimestampInAuditPeriod` (the Texts tab) has always done.
 *
 * ## What this CHANGED (deliberate, shipped behavior moves)
 *
 * Before BACKLOG-2788 this function returned the same wall-clock instant one
 * day later, which for the UTC-midnight instant `new Date("2026-07-29")`
 * produces means UTC midnight of the next day — a bound that has nothing to do
 * with the user's day. Measured, `closed_at` = "2026-07-29":
 *
 *     TZ=America/Chicago   old 2026-07-30T00:00:00.000Z  = 7:00pm local
 *                          new 2026-07-30T04:59:59.999Z  = 11:59:59.999pm local
 *     TZ=UTC               old 2026-07-30T00:00:00.000Z  = 00:00:00 next day
 *                          new 2026-07-29T23:59:59.999Z  = 11:59:59.999pm local
 *     TZ=Europe/Berlin     old 2026-07-30T00:00:00.000Z  = 2:00am NEXT day
 *                          new 2026-07-29T21:59:59.999Z  = 11:59:59.999pm local
 *
 * So the bound moves LATER west of UTC (the closing evening — up to 5 hours in
 * US zones — is now in the export and the broker submission, where the Texts
 * tab was already showing it), moves EARLIER east of UTC (early-morning
 * next-day communications the old bound wrongly swept in are now out), and
 * moves back by exactly 1ms in UTC (the instant at 00:00:00.000 of the next
 * day is the next day). BACKLOG-2781 closed ~19 of the 24 hours this class of
 * bug cost; this closes the rest.
 *
 * ## DST
 *
 * The bound is the real local midnight-minus-1ms on both transition days,
 * because the local wall-clock time is resolved with the offset in effect at
 * that wall time. Measured in America/Chicago (a naive +24h would land an hour
 * late in spring and an hour early in fall — both are covered by controls):
 *
 *     closed_at "2026-03-08"  ->  2026-03-09T04:59:59.999Z  (23h local day)
 *     closed_at "2026-11-01"  ->  2026-11-02T05:59:59.999Z  (25h local day)
 *
 * ## Which day, and whose timezone
 *
 * The calendar day is read from the leading `YYYY-MM-DD` of a string value, or
 * from the UTC components of a `Date` — because every writer of `closed_at` in
 * this app produces a DATE-ONLY value (`useAuditAddressForm.ts` `getTodayDate()`,
 * the AddressVerificationStep date input, `ExportModal.tsx` `.split("T")[0]`),
 * and the `Date` callers get theirs from `new Date(<that date string>)`, which
 * is UTC midnight. Reading LOCAL components off such a Date would name the
 * PREVIOUS day for every user west of UTC. A time-bearing `closed_at` is
 * therefore normalized to its calendar day rather than carried forward a whole
 * day (BACKLOG-2781 SR follow-up C: carrying it forward over-includes into a
 * broker submission); no live writer produces one.
 *
 * The timezone is the SYSTEM timezone of the machine at the moment of
 * computation. There is no per-user timezone setting in this app and this PR
 * does not invent one, so the honest limitation is: an agent who computes an
 * export from a laptop in a different zone than the one they worked the deal
 * in gets that machine's day boundary. Every surface on that machine still
 * agrees with every other, which is the property BACKLOG-2788 is about.
 *
 * An unparseable value still yields an Invalid Date (not `null`) exactly as
 * before, so a corrupt `closed_at` keeps failing loudly in the SQL callers
 * instead of silently reading as "no upper bound" — the confusion
 * `importPlan.ts` (BACKLOG-2749) exists to prevent.
 *
 * ## Who derives from this (census, BACKLOG-2788)
 *
 * - export surfaces: `filterByDateWindow` below (folder, enhanced pdf/csv/
 *   excel/json/txt_eml, and the orphan export-pdf channel)
 * - broker submission: the four `submissionDbService` query bounds
 * - attachment counts / attachments tab: `attachmentHandlers`,
 *   `attachmentDbService` (both LATENT — their renderer callers pass no window)
 * - auto-link candidate matching: `messageMatchingService` (was a literal
 *   `"T23:59:59.999Z"` string concat — UTC-midnight semantics)
 * - email fetch / import-cap protection window: `utils/emailDateRange.ts`
 *   `computeTransactionDateRange`, whose 30-day buffer now advances from this
 *   bound (was start-of-day+30)
 * - the Texts tab and ConversationViewModal use `isTimestampInAuditPeriod` in
 *   `src/utils/dateRangeUtils.ts`. The renderer CANNOT value-import from
 *   `electron/`, so that is a MIRROR of this rule, not a derivation of it, and
 *   it is pinned to this function by the parity corpus in
 *   `electron/__tests__/localMidnightBoundary-2788.test.ts`.
 *
 * Audit-window START bounds (`filterByDateWindow`'s start,
 * `messageMatchingService`'s `>= ?`, `computeTransactionDateRange`'s start) are
 * NOT touched by BACKLOG-2788 and are still UTC-parsed: moving them would
 * REMOVE communications from existing windows, which is a separate decision.
 *
 * Mutating this function reds the export include-set tests, the submission
 * closing-day sweeps, the attachment sweeps, the auto-link bound test, the
 * email-range test and the tab-parity corpus TOGETHER.
 */
export function auditWindowEnd(endDate: Date | string | null | undefined): Date | null {
  if (!endDate) return null;

  const day = auditWindowEndCalendarDay(endDate);
  if (!day) return new Date(NaN); // unparseable in, Invalid Date out (see above)

  const [year, monthIndex, dayOfMonth] = day;
  // LOCAL 23:59:59.999 — resolved with the UTC offset in effect at that wall
  // clock, which is what makes the two DST days above come out exact.
  return new Date(year, monthIndex, dayOfMonth, 23, 59, 59, 999);
}

/** Leading calendar day of an ISO-ish string: "2026-07-29", "2026-07-29T..." or "2026-07-29 12:00:00". */
const CALENDAR_DAY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The [year, monthIndex, day] of an audit-window boundary value, or null when
 * it cannot be read. See `auditWindowEnd` for why a `Date` is read in UTC.
 */
function auditWindowEndCalendarDay(
  value: Date | string,
): [number, number, number] | null {
  if (typeof value === "string") {
    const match = CALENDAR_DAY_PREFIX.exec(value.trim());
    if (match) {
      const year = Number(match[1]);
      const monthIndex = Number(match[2]) - 1;
      const day = Number(match[3]);
      // Guard impossible components ("2026-13-40") so they fall through to the
      // Date parser and end as an Invalid Date, as they did before.
      if (monthIndex >= 0 && monthIndex <= 11 && day >= 1 && day <= 31) {
        return [year, monthIndex, day];
      }
    }
    const parsed = new Date(value);
    if (isNaN(parsed.getTime())) return null;
    return [parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()];
  }

  if (isNaN(value.getTime())) return null;
  return [value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()];
}

function filterByDateWindow(
  communications: Communication[],
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): Communication[] {
  if (!startDate && !endDate) return communications;

  const start = startDate ? new Date(startDate) : null;
  const end = auditWindowEnd(endDate);

  return communications.filter((comm) => {
    const commDate = communicationDate(comm);
    if (start && commDate < start) return false;
    if (end && commDate > end) return false;
    return true;
  });
}

function filterByContentType(
  communications: Communication[],
  contentType: ExportContentType,
): Communication[] {
  if (contentType === "emails") return communications.filter((c) => isEmailMessage(c));
  if (contentType === "texts") return communications.filter((c) => isTextMessage(c));
  return communications;
}

/**
 * Resolve the single include-set decision for one export.
 *
 * Pure: no logging, no I/O, no database. Every entry point calls this exactly
 * once and renders from the result.
 */
export function resolveExportPlan(
  request: ExportPlanRequest,
  communications: Communication[],
): ExportPlan {
  const {
    format,
    contentType,
    attachmentType,
    emailMode,
    startDate,
    endDate,
    summaryOnly = false,
  } = request;

  const included = filterByContentType(
    filterByDateWindow(communications ?? [], startDate, endDate),
    contentType,
  );

  const includeEmails = contentType !== "texts";
  const includeTexts = contentType !== "emails";

  const writesAttachmentsToDisk =
    attachmentType !== "none" && !summaryOnly && ATTACHMENT_CAPABLE_FORMATS.has(format);

  // The attachment selection is a subset of what the export already includes:
  // an export that excludes texts can never write a text's attachments, no
  // matter what the attachment selector says.
  let attachmentComms: Communication[] = [];
  if (writesAttachmentsToDisk) {
    if (attachmentType === "email") {
      attachmentComms = included.filter((c) => isEmailMessage(c));
    } else if (attachmentType === "text") {
      attachmentComms = included.filter((c) => isTextMessage(c));
    } else {
      attachmentComms = included.filter((c) => isEmailMessage(c) || isTextMessage(c));
    }
  }

  return {
    communications: included,
    attachmentComms,
    emailRenderMode: emailMode,
    writesAttachmentsToDisk,
    includeEmails,
    includeTexts,
  };
}

/**
 * Re-apply a renderer's own ordering to the plan's attachment SELECTION.
 *
 * The plan decides membership; the renderer decides sequence (folder export
 * emits emails-ascending then texts-ascending; the enhanced export emits the
 * whole set descending). `exportAttachments()` writes a `sourceEmailIndex`
 * derived from array position into manifest.json, so those orders are
 * observable and must be preserved per format.
 *
 * Membership is taken from `plan.attachmentComms` by object identity — the
 * renderer never re-derives the predicate, which is the drift BACKLOG-2771
 * exists to remove.
 *
 * @param plan    the resolved plan
 * @param ordered the same communications in the renderer's preferred order
 */
export function orderAttachmentComms(
  plan: ExportPlan,
  ordered: Communication[],
): Communication[] {
  if (!plan.writesAttachmentsToDisk) return [];
  const selected = new Set<Communication>(plan.attachmentComms);
  return ordered.filter((comm) => selected.has(comm));
}

/**
 * Normalize an untrusted wire value into the ONE content vocabulary.
 *
 * The compiler now rejects the old `"email"`/`"text"` spelling everywhere a
 * type is in play, but IPC payloads arrive as `unknown`. A renderer running
 * from a previous build (or a bulk-export caller written against the old wire)
 * can still send the retired spelling, so the boundary maps it rather than
 * silently falling through to "both" and exporting more than the user asked for.
 */
export function normalizeContentType(value: unknown): ExportContentType {
  switch (value) {
    case "emails":
    case "email":
      return "emails";
    case "texts":
    case "text":
      return "texts";
    default:
      return "both";
  }
}

/** Normalize an untrusted wire value into the attachment vocabulary. */
export function normalizeAttachmentType(
  value: unknown,
  fallback: ExportAttachmentType,
): ExportAttachmentType {
  return value === "all" || value === "email" || value === "text" || value === "none"
    ? value
    : fallback;
}

/** Normalize an untrusted wire value into the email-render vocabulary. */
export function normalizeEmailMode(value: unknown): ExportEmailMode {
  return value === "individual" ? "individual" : "thread";
}
