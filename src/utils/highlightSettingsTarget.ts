/**
 * Scroll a Settings element into view and briefly ring it (BACKLOG-3964).
 *
 * Shared by the Settings page's section routing (open at a section) and
 * openEmailSettings' precise-target lookup, so both land the same way.
 */
const RING = ["ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg"];

export function highlightSettingsTarget(
  target: HTMLElement,
  block: ScrollLogicalPosition = "start",
): void {
  target.scrollIntoView({ behavior: "smooth", block });
  target.classList.add(...RING);
  setTimeout(() => target.classList.remove(...RING), 3000);
}
