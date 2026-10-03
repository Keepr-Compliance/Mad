/**
 * C1 (UX redesign): keepr://link (the extension's "Open Keepr" while linking)
 * opens Settings › Google Messages at the "Enter the code from your browser"
 * panel. The deep link carries nothing: it only opens the screen.
 */
import { useEffect } from "react";
import { rcsImportService } from "../services/rcsImportService";
import { scrollToSettingsSection } from "../utils/scrollToSettingsSection";
import { LINK_PANEL_ID } from "../components/settings/android/LinkBrowserPanel";

export function useOpenLinkScreen(openSettings: () => void): void {
  useEffect(
    () =>
      rcsImportService.onOpenLinkScreen(() => {
        openSettings();
        scrollToSettingsSection(LINK_PANEL_ID);
      }),
    [openSettings],
  );
}
