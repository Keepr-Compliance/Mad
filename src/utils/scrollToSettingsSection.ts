/**
 * Scroll to and briefly highlight a section of the Settings modal (by element
 * id), once the modal has rendered. Shared by every "open Settings at X" entry
 * point (the Dashboard's sync warning, Google Messages' "Change").
 */
export function scrollToSettingsSection(elementId: string, delayMs = 500): void {
  setTimeout(() => {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg");
    setTimeout(() => {
      el.classList.remove("ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg");
    }, 3000);
  }, delayMs);
}
