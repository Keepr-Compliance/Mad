/**
 * Import Plan Resolver — BACKLOG-2772
 *
 * ONE decider for what every macOS Messages import entry point fetches.
 *
 * The founder's framing, 2026-08-20: *"clicking Import is the same as creating
 * a transaction whose dates go past the existing cache."* This module makes
 * that literally true in code. It is the mirror of `exportPlan.ts`
 * (BACKLOG-2771) — same class, opposite direction.
 *
 * ## What was wrong, and where
 *
 * The CORE was never the problem. Every path already funnelled into
 * `computeImportCutoffNano`, and that function still does the arithmetic here.
 * The ASSEMBLY was the problem: four entry points each built their own
 * `{window, cap, attachments, auditPeriodStart}` before calling it.
 *
 *   1. `messageImportHandlers.ts` — loaded preferences, ran its own
 *      non-rejected-transaction query, and collapsed `maxMessages` with `??`.
 *   2. the estimate channel — passed whatever the renderer sent, unassembled.
 *   3. `messagesSyncTrigger.ts` — a third assembler, whose entire filter
 *      literal was `{ auditPeriodStart }`: no lookback, no cap, no attachment
 *      preference.
 *   4. background sync — reached (2) and (3)'s assemblies.
 *
 * Every import defect of that week lived in assembly, never in the core:
 * BACKLOG-2561 (four assemblers disagreeing on "All time"), 2760 (the estimate
 * assembler racing the button's), 2733 (the `??` collapse below), and the
 * trigger quietly running with the cap off.
 *
 * A caller now states WHAT IT WANTS (`ImportPlanRequest`) and receives WHAT IT
 * GETS (`ImportPlan`). No entry point decides on its own.
 *
 * ## The two rules the founder settled
 *
 * **D2' (2026-08-20)** — ONE window rule for BOTH buttons. Import and Force
 * Re-import fetch the same range; they differ only in `mode`:
 *   - `"delta"`     — fetch and process only what is missing in the window.
 *   - `"reprocess"` — re-fetch and re-process EVERYTHING in the window.
 * `fetchStartISO` has no per-button branch. In the founder's words: *"force
 * re-import will always cover the whole window… it's more about the processing
 * of msgs."*
 *
 * **Cap' (2026-08-20, final)** — "Maximum messages" applies only OUTSIDE the
 * audit periods of non-rejected deals. Inside such a period history is always
 * complete and never counts against the cap. Closed deals are protected exactly
 * like live ones ("treat closed as live" is the standing definition, not a
 * stopgap); REJECTED deals protect nothing. This replaced D1' entirely — there
 * are no set-aside states and no comeback rule.
 *
 * The old shape was all-or-nothing: `capApplies = !auditPeriodActive && …`, so
 * a single pending transaction disabled the cap for the ENTIRE library. Cap'
 * keeps the audit guarantee (never truncate an audit window) without spending
 * it on the casual history that has nothing to do with any deal.
 *
 * ## Scope: this resolver decides the PLAN, not the EXECUTION.
 *
 * It is pure — no I/O, no database, no logging, no clock except the injectable
 * `now`. Reading preferences and deriving deal spans is the job of the input
 * assembler (`importPlanInputs.ts`), which is itself shared by every entry
 * point; turning a plan into SQL is the job of the import service. Keeping this
 * function pure is what lets the boundary suite assert plan OBJECTS at four
 * call sites instead of chasing four sets of effects.
 */

import { MAC_EPOCH } from "../constants";
import {
  computeImportCutoffNano,
  resolveLookbackMonths,
  DEFAULT_LOOKBACK_MONTHS,
} from "./macOSMessagesImportService/importHelpers";

const NANOS_PER_MS = 1_000_000;

/**
 * How an import processes what it fetches (D2').
 *
 * The buttons differ ONLY here. Both cover the same window.
 */
export type ImportMode = "delta" | "reprocess";

/**
 * The cap that applies when the user has expressed no preference at all.
 *
 * Exported and defined ONCE. It previously existed as a bare literal inside
 * `messageImportHandlers.ts`, which is how BACKLOG-2733 happened.
 */
export const DEFAULT_MAX_MESSAGES = 50000;

/**
 * The stored `messageImport.filters` preference object, as persisted.
 *
 * Deliberately the raw shape rather than a pre-resolved one: resolving it is
 * this module's job, and accepting a resolved value would let a caller resolve
 * it differently first — the exact drift being removed.
 */
export interface StoredImportFilters {
  lookbackMonths?: number | null;
  maxMessages?: number | null;
  skipAttachments?: boolean;
}

/**
 * One deal's audit period.
 *
 * `endISO` is null for a deal that has not closed — an open-ended period
 * running to the present. Callers MUST pass only NON-REJECTED deals; a rejected
 * deal carries no audit obligation and protects nothing (BACKLOG-2308 settled
 * that filter as `status != 'rejected'`, and the export gate reads the same
 * one, so the two cannot disagree).
 */
export interface AuditSpan {
  startISO: string;
  endISO: string | null;
}

/**
 * An audit period expressed in the units the fetch actually filters on:
 * nanoseconds since the Apple epoch (2001-01-01), matching `message.date`.
 *
 * `endNano` null means open-ended — no upper bound.
 */
export interface ProtectedSpan {
  startNano: number;
  endNano: number | null;
}

/**
 * Something the resolver decided AGAINST the user's raw settings.
 *
 * This is DATA, not UI. BACKLOG-2749's one pre-import dialog renders exactly
 * this list, and renders nothing at all when it is empty. Emitting it here —
 * rather than having the dialog re-derive "did anything get overridden?" —
 * is what keeps the dialog from offering a choice the run cannot honour.
 */
export interface ImportPlanOverride {
  /**
   * The window reaches further back than the user's own "Import messages from"
   * selection, because a deal's audit period needs it.
   */
  kind: "window-extended-by-deals";
  /** What the user's selection alone would have fetched from (null = All time). */
  requestedStartISO: string | null;
  /** What the plan will actually fetch from. */
  effectiveStartISO: string;
}

/** What a caller asks the resolver for. */
export interface ImportPlanRequest {
  mode: ImportMode;
  /** The stored preference object (may be absent — see `resolveMaxMessages`). */
  storedFilters?: StoredImportFilters | null;
  /**
   * Audit periods of NON-REJECTED deals. Empty when the user has no deals.
   * These both WIDEN the window and PROTECT their contents from the cap.
   */
  auditSpans?: AuditSpan[];
  /**
   * An explicit lower bound this particular run must reach, independent of the
   * spans — the transaction trigger's `proposedStartISO` (a deal being created,
   * or its start date moved earlier). It widens the window exactly as a span
   * does, but it does not by itself protect anything from the cap: the deal it
   * belongs to supplies the protecting span once it exists.
   */
  requestedStartISO?: string | null;
}

/** What the caller gets. Every entry point fetches from exactly this. */
export interface ImportPlan {
  mode: ImportMode;
  /**
   * The lower bound of the fetch, ISO. `null` = unbounded ("All time" with
   * nothing reaching further back).
   */
  fetchStartISO: string | null;
  /** The same bound in Apple-epoch nanoseconds — what the SQL filters on. */
  cutoffNano: number | null;
  /**
   * The "Maximum messages" cap, or `null` for Unlimited.
   *
   * Applies ONLY to messages outside `protectedSpans` (Cap'). A non-null value
   * here is therefore a cap on the UNPROTECTED remainder, never on the window.
   */
  effectiveCap: number | null;
  /**
   * Audit periods whose messages are always fetched complete and never counted
   * against `effectiveCap`.
   */
  protectedSpans: ProtectedSpan[];
  /** Whether attachment FILES are copied (the inverse of `skipAttachments`). */
  fetchAttachments: boolean;
  /** Everything the plan decided against the user's raw settings. */
  overrides: ImportPlanOverride[];
}

/**
 * BACKLOG-2733: resolve the stored `maxMessages` preference, distinguishing
 * **"no preference stored"** from **"the user explicitly chose Unlimited"**.
 *
 * The exact shape of `resolveLookbackMonths`, and it exists for the exact same
 * reason. The Settings dropdown spells "Unlimited" as an explicit `null`
 * (`MacOSMessagesImportSettings.tsx`: `value === "unlimited" ? null : Number(value)`),
 * and the handler collapsed it with `maxMessages ?? DEFAULT_MAX_MESSAGES`.
 * `null ?? 50000` is `50000`, so a user who asked for everything was capped —
 * and, before BACKLOG-2744, capped to the OLDEST 50,000, losing precisely the
 * recent conversation they cared about.
 *
 * The key can be absent while `filters` exists: changing only the lookback
 * writes `{ lookbackMonths: N }`, and the preferences deep-merge leaves
 * `maxMessages` absent.
 *
 * @param filters - The stored `messageImport.filters` object (may be absent)
 * @param defaultMax - Cap to use when no preference is stored
 * @returns The cap, or `null` for Unlimited
 */
export function resolveMaxMessages(
  filters: { maxMessages?: number | null } | null | undefined,
  defaultMax: number = DEFAULT_MAX_MESSAGES
): number | null {
  if (!filters) return defaultMax;
  const stored = filters.maxMessages;
  // `undefined` = absent = no preference. `null` = an explicit "Unlimited".
  return stored === undefined ? defaultMax : stored;
}

/** ISO instant → Apple-epoch nanoseconds, or null when unparseable. */
function isoToNano(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return (ms - MAC_EPOCH) * NANOS_PER_MS;
}

/** Apple-epoch nanoseconds → ISO instant. */
function nanoToISO(nano: number): string {
  return new Date(MAC_EPOCH + nano / NANOS_PER_MS).toISOString();
}

/**
 * The earliest instant any audit span or explicit request reaches back to.
 *
 * Invalid dates are DROPPED rather than treated as epoch-zero: a malformed
 * `started_at` widening every import to the beginning of time would be a
 * silent, expensive full-device scan.
 */
function earliestRequiredStartISO(
  spans: AuditSpan[],
  requestedStartISO: string | null | undefined
): string | null {
  const candidates: number[] = [];

  for (const span of spans) {
    const ms = new Date(span.startISO).getTime();
    if (!Number.isNaN(ms)) candidates.push(ms);
  }
  if (requestedStartISO) {
    const ms = new Date(requestedStartISO).getTime();
    if (!Number.isNaN(ms)) candidates.push(ms);
  }

  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates)).toISOString();
}

/**
 * Resolve the single fetch decision for one import run.
 *
 * Pure: no logging, no I/O, no database.
 */
export function resolveImportPlan(
  request: ImportPlanRequest,
  now: Date = new Date()
): ImportPlan {
  const { mode, storedFilters, requestedStartISO } = request;
  const auditSpans = request.auditSpans ?? [];

  const lookbackMonths = resolveLookbackMonths(
    storedFilters,
    DEFAULT_LOOKBACK_MONTHS
  );
  const effectiveCap = resolveMaxMessages(storedFilters);

  // ------------------------------------------------------------------
  // The window — ONE rule, both buttons (D2').
  // ------------------------------------------------------------------
  // The union of the user's selection and everything the deals require. The
  // arithmetic is `computeImportCutoffNano`, unchanged: it takes the EARLIER of
  // the lookback cutoff and the audit floor, and short-circuits an explicit
  // "All time" to unbounded. Generalising N spans to the single floor it
  // accepts is the ONLY thing this adds — the core keeps its one home.
  const requiredStartISO = earliestRequiredStartISO(auditSpans, requestedStartISO);
  const cutoffNano = computeImportCutoffNano(
    { lookbackMonths, auditPeriodStart: requiredStartISO },
    now
  );
  const fetchStartISO = cutoffNano === null ? null : nanoToISO(cutoffNano);

  // ------------------------------------------------------------------
  // Overrides — what the plan does that the user did not ask for.
  // ------------------------------------------------------------------
  // Only ever a window STRETCH. Cap' removed the other disclosure the old
  // design owed the user (a cap set aside), because under Cap' the cap is never
  // set aside — it is scoped.
  const overrides: ImportPlanOverride[] = [];
  const selectionOnlyCutoff = computeImportCutoffNano({ lookbackMonths }, now);
  if (
    selectionOnlyCutoff !== null &&
    cutoffNano !== null &&
    cutoffNano < selectionOnlyCutoff
  ) {
    overrides.push({
      kind: "window-extended-by-deals",
      requestedStartISO: nanoToISO(selectionOnlyCutoff),
      effectiveStartISO: nanoToISO(cutoffNano),
    });
  }

  // ------------------------------------------------------------------
  // Protected spans — the cap's exemption, scoped (Cap').
  // ------------------------------------------------------------------
  // Every non-rejected deal's period, in the units the fetch filters on. An
  // unparseable start is dropped: it cannot widen the window (above) and must
  // not silently protect an unbounded range here either.
  const protectedSpans: ProtectedSpan[] = [];
  for (const span of auditSpans) {
    const startNano = isoToNano(span.startISO);
    if (startNano === null) continue;

    // `endISO === null` is a DELIBERATE open end — a deal that has not closed,
    // whose audit period runs to the present. An endISO that was SUPPLIED but
    // cannot be read is a data fault, and the two must not collapse into the
    // same value: reading a corrupt `closed_at` as "open-ended" would silently
    // exempt everything after that deal's start from the cap, forever. That is
    // BACKLOG-2749's complaint (a cap the user set being ignored) reintroduced
    // by a parse failure.
    //
    // Such a span still WIDENS the window — its start is valid and the deal's
    // history must still be fetched — but it protects nothing, because a period
    // whose end cannot be described cannot be honestly exempted. Widening reads
    // `startISO` directly in `earliestRequiredStartISO`, so dropping it here
    // costs no coverage.
    //
    // Unreachable from `deriveAuditSpans`, which passes an explicit `null` for
    // an open deal and a valid Date otherwise — which is exactly the kind of
    // assumption that stops being true quietly.
    const endNano = isoToNano(span.endISO);
    if (span.endISO !== null && span.endISO !== undefined && endNano === null) {
      continue;
    }

    protectedSpans.push({ startNano, endNano });
  }

  return {
    mode,
    fetchStartISO,
    cutoffNano,
    effectiveCap,
    protectedSpans,
    fetchAttachments: storedFilters?.skipAttachments !== true,
    overrides,
  };
}
