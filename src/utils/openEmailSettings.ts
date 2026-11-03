/**
 * openEmailSettings (BACKLOG-2127)
 *
 * Single source of truth for the "take the user to reconnect their mailbox"
 * navigation. Opens Settings at the Email Connections section
 * (`#settings-email`).
 *
 * Extracted so the SystemHealthMonitor reconnect banner and the
 * SyncStatusIndicator reconnect CTA drive the EXACT same navigation instead of
 * each inventing their own — the user lands in the same place regardless of
 * which surface they clicked.
 *
 * @module utils/openEmailSettings
 */
import { highlightSettingsTarget } from "./highlightSettingsTarget";

/**
 * Open Settings at the email-connections section.
 *
 * BACKLOG-3964: the section is the Settings page's own target (`openSettings`
 * stores it; the page scrolls once its preferences have loaded), so landing on
 * it no longer depends on a timer beating the load.
 *
 * BACKLOG-3888: `targetTestId` names a more precise element inside it (e.g. the
 * "Connect Outlook" button, `email-connection-microsoft-connect`). It only
 * exists once Settings has loaded the connection status, and only when that
 * mailbox is disconnected, so it is looked for a few times; when found it is
 * scrolled to and highlighted on top of the section landing.
 *
 * @param onOpenSettings Callback that opens Settings at a section.
 * @param targetTestId Optional data-testid of the element to land on.
 */
export function openEmailSettings(
  onOpenSettings: (scrollTarget?: string) => void,
  targetTestId?: string,
): void {
  onOpenSettings("settings-email");
  if (!targetTestId) return;
  const attempt = (triesLeft: number) => {
    const precise = document.querySelector<HTMLElement>(`[data-testid="${targetTestId}"]`);
    if (precise) {
      highlightSettingsTarget(precise, "center");
      return;
    }
    if (triesLeft > 0) {
      setTimeout(() => attempt(triesLeft - 1), OPEN_EMAIL_SETTINGS_RETRY_MS);
    }
  };
  setTimeout(() => attempt(OPEN_EMAIL_SETTINGS_RETRIES), 150);
}

/** BACKLOG-3888: how long to keep looking for a precise target (~2 s). */
export const OPEN_EMAIL_SETTINGS_RETRIES = 12;
export const OPEN_EMAIL_SETTINGS_RETRY_MS = 150;
