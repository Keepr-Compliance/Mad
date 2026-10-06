/**
 * Live (founder, 2026-10-05): after a Keepr update, Downloads/"Keepr
 * Extension" kept the old extension (it was only copied by the install step).
 * At app start — an update restarts the app — Keepr refreshes a folder the
 * user already has when it bundles a newer extension. Only for the unpacked
 * install: a Chrome Web Store install updates itself. Mounted once
 * (AppModals); never throws; a folder in use is tried again next start.
 */

import { useEffect } from "react";
import { rcsImportService } from "../services/rcsImportService";
import { EXTENSION_PUBLISHED } from "../components/settings/android/extensionDistribution";

export function useExtensionFolderRefresh(published: boolean = EXTENSION_PUBLISHED): void {
  useEffect(() => {
    if (published) return;
    void rcsImportService.refreshExtensionFolder();
  }, [published]);
}
