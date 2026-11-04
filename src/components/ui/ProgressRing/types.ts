/** BACKLOG-3965: props for the app-local ProgressRing. */
export interface ProgressRingProps {
  /** Required items done (main's count; not computed here). */
  done: number;
  /** Required items in total (main's count, summed across the deal's checklists). */
  total: number;
  /** Accessible name. Defaults to "N of M required done" / "No required items". */
  label?: string;
  /** Rendered width and height in px. Defaults to 34 (mock v6 Recent row). */
  size?: number;
  className?: string;
}
