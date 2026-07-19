/**
 * openEmailSettings (BACKLOG-2127)
 *
 * Single source of truth for the "take the user to reconnect their mailbox"
 * navigation. Opens the Settings modal and scrolls to + briefly highlights the
 * Email Connections section (`#settings-email`).
 *
 * Extracted so the SystemHealthMonitor reconnect banner and the
 * SyncStatusIndicator reconnect CTA drive the EXACT same navigation instead of
 * each inventing their own — the user lands in the same place regardless of
 * which surface they clicked.
 *
 * @module utils/openEmailSettings
 */

/**
 * Open Settings and highlight the email-connections section.
 *
 * @param onOpenSettings Callback that opens the Settings modal.
 */
export function openEmailSettings(onOpenSettings: (scrollTarget?: string) => void): void {
  onOpenSettings();
  // Scroll to + highlight the email connections section after the modal mounts.
  setTimeout(() => {
    const emailSection = document.getElementById("settings-email");
    if (emailSection) {
      emailSection.scrollIntoView({ behavior: "smooth", block: "start" });
      emailSection.classList.add("ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg");
      setTimeout(() => {
        emailSection.classList.remove("ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg");
      }, 3000);
    }
  }, 150);
}
