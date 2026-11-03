/**
 * ProgressRing — BACKLOG-3965 PR-4a.
 *
 * A small circular "N of M done" indicator for the Dashboard's Recent rows
 * (mock v6). App-local, plain SVG, kit tokens only: a gray-200 rail and a
 * primary-600 arc, no gradient. No Radix dependency — `role="progressbar"`
 * with its aria values is the whole accessibility contract.
 *
 * It renders the counts it is given and decides nothing about which items
 * count: the caller passes main's required-item numbers for the whole deal
 * (summed across every checklist, checklistDbService.ts), the same numbers the
 * deal's Checklist tab shows. A total of 0 renders an empty ring.
 */
import React from "react";
import type { ProgressRingProps } from "./types";

/** The circle's circumference is 100 at this radius, so dash lengths are percents. */
const RADIUS = 15.9155;
const VIEWBOX = 36;
const CENTER = VIEWBOX / 2;
const STROKE_WIDTH = 3.5;

/** Percent done, 0-100. 0 when total is 0 (never NaN or Infinity). */
export function progressPercent(done: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(total) || !Number.isFinite(done)) return 0;
  return Math.min(100, Math.max(0, (done / total) * 100));
}

export function defaultProgressLabel(done: number, total: number): string {
  return total > 0 ? `${done} of ${total} required done` : "No required items";
}

export function ProgressRing({
  done,
  total,
  label,
  size = 34,
  className,
}: ProgressRingProps): React.ReactElement {
  const pct = progressPercent(done, total);
  const max = total > 0 && Number.isFinite(total) ? total : 0;
  const now = max > 0 && Number.isFinite(done) ? Math.min(max, Math.max(0, done)) : 0;
  return (
    <span
      role="progressbar"
      aria-label={label ?? defaultProgressLabel(done, total)}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={now}
      className={["inline-flex shrink-0", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
      data-testid="progress-ring"
    >
      <svg
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        width={size}
        height={size}
        className="-rotate-90"
        aria-hidden="true"
        focusable="false"
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          className="stroke-gray-200"
          data-part="rail"
        />
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          // A round cap on a zero-length dash still draws a dot; butt at 0 %.
          strokeLinecap={pct > 0 ? "round" : "butt"}
          strokeDasharray={`${pct.toFixed(1)} 100`}
          className="stroke-primary-600"
          data-part="arc"
        />
      </svg>
    </span>
  );
}

export default ProgressRing;
