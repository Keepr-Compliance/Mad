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
 * BACKLOG-3888: `targetTestId` names a more precise element inside it (e.g. the
 * "Connect Outlook" button, `email-connection-microsoft-connect`). When that
 * element is present it is scrolled to and highlighted instead; otherwise the
 * section is, exactly as before.
 *
 * @param onOpenSettings Callback that opens the Settings modal.
 * @param targetTestId Optional data-testid of the element to land on.
 */
export function openEmailSettings(
  onOpenSettings: (scrollTarget?: string) => void,
  targetTestId?: string,
): void {
  onOpenSettings();
  // Scroll to + highlight after the modal mounts. A precise target (e.g. a
  // Connect button) only exists once Settings has loaded the connection
  // status, so it is looked for a few times before falling back to the section.
  const highlight = (target: HTMLElement, block: ScrollLogicalPosition) => {
    target.scrollIntoView({ behavior: "smooth", block });
    target.classList.add("ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg");
    setTimeout(() => {
      target.classList.remove("ring-2", "ring-amber-400", "ring-offset-2", "rounded-lg");
    }, 3000);
  };
  const attempt = (triesLeft: number) => {
    const precise = targetTestId
      ? document.querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`)
      : null;
    if (precise) {
      highlight(precise, "center");
      return;
    }
    if (targetTestId && triesLeft > 0) {
      setTimeout(() => attempt(triesLeft - 1), OPEN_EMAIL_SETTINGS_RETRY_MS);
      return;
    }
    const emailSection = document.getElementById("settings-email");
    if (emailSection) highlight(emailSection, "start");
  };
  setTimeout(() => attempt(OPEN_EMAIL_SETTINGS_RETRIES), 150);
}

/** BACKLOG-3888: how long to keep looking for a precise target (~2 s). */
export const OPEN_EMAIL_SETTINGS_RETRIES = 12;
export const OPEN_EMAIL_SETTINGS_RETRY_MS = 150;
