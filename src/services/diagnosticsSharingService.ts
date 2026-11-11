/**
 * "Share diagnostics with Keepr" — renderer service (BACKLOG-4181).
 *
 * The repo rule: components never call `window.api` directly. The Data &
 * Privacy settings toggle reads and writes the switch through here.
 */

export interface DiagnosticsSharingResult {
  success: boolean;
  enabled?: boolean;
  error?: string;
}

/** The saved choice, or null when it could not be read. */
export async function getDiagnosticsSharing(): Promise<boolean | null> {
  const result = await window.api.privacy?.getDiagnosticsSharing?.();
  return result?.success && typeof result.enabled === "boolean" ? result.enabled : null;
}

/** Save the choice. `enabled` is the value now in effect (it can differ when the save failed). */
export async function setDiagnosticsSharing(enabled: boolean): Promise<DiagnosticsSharingResult> {
  const result = await window.api.privacy?.setDiagnosticsSharing?.(enabled);
  return result ?? { success: false, error: "Not available" };
}
