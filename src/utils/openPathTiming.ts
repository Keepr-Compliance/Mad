/**
 * BACKLOG-3884: timing lines for opening a transaction, relayed to main.log as
 * `[Renderer] [TxnOpen] ...`. Counts, sizes and durations only — never ids,
 * names, addresses or content.
 */
import logger from "./logger";
import { setRendererStallPhase, getRendererStallPhase } from "./rendererStallLogger";

export function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Approximate serialized size of a row list without serializing all of it:
 * the JSON length of up to `sample` evenly spaced rows, scaled to the count.
 */
export function estimateRowsBytes(rows: readonly unknown[], sample = 20): number {
  if (rows.length === 0) return 0;
  try {
    const step = Math.max(1, Math.floor(rows.length / sample));
    let bytes = 0;
    let n = 0;
    for (let i = 0; i < rows.length && n < sample; i += step, n++) {
      bytes += JSON.stringify(rows[i])?.length ?? 0;
    }
    return Math.round((bytes / n) * rows.length);
  } catch {
    return -1;
  }
}

export function logOpenPath(line: string): void {
  logger.info(`[TxnOpen] ${line}`);
}

/**
 * Log `<label> ms=<since mount>` on the first frame after the current commit
 * (requestAnimationFrame fires before the next paint, so the time includes the
 * render/commit work that precedes it). Clears `phase` if it is still the
 * stall phase.
 */
export function logAfterNextPaint(label: string, since: number, clearPhase?: string): void {
  const done = () => {
    logOpenPath(`${label} ms=${Math.round(nowMs() - since)}`);
    if (clearPhase && getRendererStallPhase() === clearPhase) setRendererStallPhase(null);
  };
  try {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(done);
    else done();
  } catch {
    // Telemetry only.
  }
}
