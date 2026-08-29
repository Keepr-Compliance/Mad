/**
 * BACKLOG-2898 — user-visible SYNC STEP change detection.
 *
 * The problem this exists to solve, measured on the founder's real PC log:
 * a 703,761-byte / 4,023-line `main.log` covering 21 minutes contained 2,824
 * `[IPhoneSyncFlow] Rendering: progress` records — 80.7% of the file — and
 * every one of them was byte-identical apart from its timestamp. The main
 * process sends a NEW progress object per file transferred, React re-renders,
 * and an effect logged a line per render. 703 KB carrying one fact, while the
 * ~8 lines anyone actually needed had already rotated away.
 *
 * The founder's framing: report "new prompts being rendered for the user or
 * new steps being done in the back end" — transitions, not frames.
 *
 * So: keep the last emitted STEP SIGNATURE and emit only when it changes.
 * A signature deliberately ignores counter movement inside an otherwise
 * unchanged message ("Saving messages... 412,000 of 663,000" and
 * "...413,000 of 663,000" are the same step being shown to the user), but is
 * sensitive to the phase, the view, and the wording of the message.
 *
 * Pure and dependency-free so it can be driven in a loop by the log-capacity
 * control, which replays a full worst-case sync through the real emit site.
 */

/** A user-visible step: what the user is being shown right now. */
export interface SyncStepInput {
  /** Which primary view is on screen (IPhoneSyncFlow's resolved `view`). */
  view: string;
  /** Sync phase driving that view, when there is one. */
  phase?: string | null;
  /** The message the user reads. */
  message?: string | null;
  /** Extra flags whose change is itself a step change. */
  detail?: Record<string, string | number | boolean | null | undefined>;
}

/**
 * Collapse volatile counters so a moving progress readout does not read as a
 * new step. Runs of digits — with thousands separators and decimals — become
 * a single `#`.
 *
 * "Saving messages... 412,000 of 663,000"  -> "Saving messages... # of #"
 * "uploading backup index (563.0 MB)..."   -> "uploading backup index (# MB)..."
 *
 * Deliberately coarse: two steps that differ ONLY by a number are the same
 * step as far as the user is concerned.
 */
export function normalizeStepMessage(message: string | null | undefined): string {
  if (!message) return "";
  return message.replace(/\d[\d.,]*/g, "#").trim();
}

/** Stable, order-independent rendering of the detail flags. */
function formatDetail(detail: SyncStepInput["detail"]): string {
  if (!detail) return "";
  return Object.keys(detail)
    .sort()
    .map((key) => `${key}=${String(detail[key])}`)
    .join(" ");
}

/**
 * The identity of a step. Two inputs with the same signature are the same
 * thing being shown to the user and must not both be logged.
 */
export function stepSignature(step: SyncStepInput): string {
  return [
    step.view,
    step.phase ?? "",
    normalizeStepMessage(step.message),
    formatDetail(step.detail),
  ].join("|");
}

/**
 * The log line for a step. Carries the phase and the message, so a support
 * log shows what the user was looking at, not that a frame happened.
 */
export function formatStepLine(step: SyncStepInput): string {
  const parts = [`Step: ${step.view}`];
  if (step.phase) parts.push(`phase=${step.phase}`);
  if (step.message) parts.push(step.message);
  const detail = formatDetail(step.detail);
  if (detail) parts.push(detail);
  return parts.join(" · ");
}

/**
 * Emits a line only when the step changes.
 *
 * ```ts
 * const line = stepLog.next({ view, phase, message });
 * if (line) logger.info(`[IPhoneSyncFlow] ${line}`);
 * ```
 */
export class SyncStepChangeLog {
  private lastSignature: string | null = null;

  /** @returns the line to log, or `null` when this is the same step again. */
  next(step: SyncStepInput): string | null {
    const signature = stepSignature(step);
    if (signature === this.lastSignature) return null;
    this.lastSignature = signature;
    return formatStepLine(step);
  }

  /** Forget the last step, so the next call emits regardless. */
  reset(): void {
    this.lastSignature = null;
  }
}
