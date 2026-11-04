/**
 * ProgressRing exports (BACKLOG-3965). App-local; lift to packages/ui only if a
 * portal needs it.
 */
export { ProgressRing, progressPercent, defaultProgressLabel } from "./ProgressRing";
export type { ProgressRingProps } from "./types";
