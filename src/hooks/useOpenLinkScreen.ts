/**
 * C1 (UX redesign): keepr://link (the extension's "Open Keepr" while linking)
 * opens the Sync Android modal at its link step — the same screen the
 * dashboard and Settings' Link open (founder 2026-10-04: Settings hosts no
 * copy of it). The deep link carries nothing: it only opens the screen.
 */
import { useEffect } from "react";
import { rcsImportService } from "../services/rcsImportService";
import { requestLinkStep } from "../components/settings/android/androidSyncIntent";

export function useOpenLinkScreen(openSyncAndroid: () => void): void {
  useEffect(
    () =>
      rcsImportService.onOpenLinkScreen(() => {
        requestLinkStep();
        openSyncAndroid();
      }),
    [openSyncAndroid],
  );
}
