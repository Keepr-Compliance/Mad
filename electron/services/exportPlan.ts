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
 * BACKLOG-2343: the audit window end (a transaction's `closed_at`) is a DATE
 * like "2026-07-29", which `new Date()` parses as UTC midnight. A text sent late
 * on the closing day in a timezone west of UTC is stored with a `sent_at` that
 * rolls into the next calendar day, so a naive `commDate > end` DROPS it and the
 * exported Audit Summary reads "TOTAL TEXT MESSAGES: 0". Advancing the end
 * boundary one day makes the whole closing day inclusive. Errs toward INCLUDING
 * borderline messages, which is the safe direction for an audit export.
 *
 * This is now the only copy consumed by the app's EXPORT surfaces — folder,
 * enhanced (pdf/csv/excel/json/txt_eml) and the orphan export-pdf channel all
 * read it. Mutating the `+ 1` reds the tests of every export format that has an
 * audit window, together.
 *
 * BACKLOG-2781 — this is now the closing-day boundary for the export surfaces
 * AND for the broker submission and attachment-count surfaces. It is NOT every
 * `closed_at`-derived boundary in `electron/`: `messageMatchingService.ts`
 * appends a literal `"T23:59:59.999Z"` to its end date and `utils/emailDateRange.ts`
 * advances `closed_at` by a 30-day buffer. Those serve different questions
 * (candidate matching, sync range) and their unification is separate filed work.
 *
 * Six sites used to compute the audit-window end themselves as
 * `new Date(closed_at).setHours(23,59,59,999)`: four in `submissionDbService`
 * (the broker submission package), one in `attachmentHandlers`
 * (`transactions:get-attachment-counts`) and one in `attachmentDbService`
 * (the transaction Attachments tab). `setHours` applies LOCAL hours to the
 * UTC-midnight instant `new Date("2026-07-29")` produces, so their bound landed
 * EARLY on the closing day itself and the divergence was timezone-dependent:
 *
 *     this function      2026-07-30T00:00:00.000Z   (every timezone)
 *     the six old sites  2026-07-29T23:59:59.999Z   under TZ=UTC
 *                        2026-07-29T04:59:59.999Z   under TZ=America/Chicago
 *
 * A text at 2026-07-29T05:30Z — 12:30am local ON the closing day — was in the
 * agent's exported audit package but silently absent from the broker's
 * submission. All six now call this function, so a submission and an export of
 * the same transaction cover the same days.
 *
 * Of the six, only the four `submissionDbService` sites are reached with a real
 * window by the shipping app. Both attachment sites are LATENT: their renderer
 * callers (`TransactionDetails.tsx`) pass no audit window today. They are fixed
 * because their stated contract is parity with the submission path.
 *
 * Accepts a `Date` as well as a date string because those callers receive one
 * already parsed (`submissionService.ts` does `new Date(transaction.closed_at)`).
 * Both forms yield the same instant.
 *
 * `setDate` advances the LOCAL day number and preserves the local time-of-day.
 * For a UTC-midnight value that is a 24-hour advance in UTC on an ordinary day,
 * but 23 or 25 hours across a DST transition — measured in America/Chicago:
 *
 *     closed_at "2026-03-08"  ->  2026-03-08T23:00:00.000Z   (+23h, spring forward)
 *     closed_at "2026-11-01"  ->  2026-11-02T01:00:00.000Z   (+25h, fall back)
 *
 * So the bound is NOT timezone-independent on those two days a year. It is left
 * as-is deliberately: the skew is inherited from this single function, so the
 * export and the submission skew together and still agree with each other, which
 * is the property BACKLOG-2781 exists to restore. A DST-exact bound would be a
 * change to the shipped export behavior and belongs in its own item.
 *
 * Mutating the `+ 1` reds every export format's audit-window test AND the
 * closing-day sweeps in `submissionDbService.closingDay-2781.test.ts`,
 * `attachmentDbService.closingDay-2781.test.ts` and
 * `attachmentHandlers.closingDay-2781.test.ts`, together.
 */
export function auditWindowEnd(endDate: Date | string | null | undefined): Date | null {
  if (!endDate) return null;
  const end = new Date(endDate);
  end.setDate(end.getDate() + 1);
  return end;
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
