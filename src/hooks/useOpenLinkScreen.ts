/**
 * C1 (UX redesign): keepr://link (the extension's "Open Keepr" while linking)
 * opens the Sync Android modal at its link step — the same screen the
 * dashboard and Settings' Link open (founder 2026-10-04: Settings hosts no
 * copy of it). The deep link carries nothing: it only opens the screen.
 */
import { useEffect } from "react";
import { rcsImportService } from "../services/rcsImportService";

export function useOpenLinkScreen(openSyncAndroid: (start: "link") => void): void {
  useEffect(
    () =>
      rcsImportService.onOpenLinkScreen((payload) => {
        // Windows: the code from the clipboard waits for the link box.
        rcsImportService.holdLinkCodePrefill(payload.code);
        openSyncAndroid("link");
      }),
    [openSyncAndroid],
  );
}
