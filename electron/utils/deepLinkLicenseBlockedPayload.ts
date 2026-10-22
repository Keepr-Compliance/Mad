/**
 * BACKLOG-4041: the payload main sends on `auth:deep-link-license-blocked`.
 *
 * The return type is annotated, so adding any other field to the literal
 * below is an excess-property type error. The renderer reads only these two
 * (Login.tsx handleLicenseBlocked, AppRouter handleLicenseBlocked).
 */
import type { DeepLinkLicenseBlockedPayload } from "../types/ipc";

export function licenseBlockedPayload(
  userId: string,
  blockReason: string | undefined,
): DeepLinkLicenseBlockedPayload {
  return {
    userId,
    // Optional on LicenseValidationResult; "unknown" maps the same as an
    // absent reason in upgradeReasonFor().
    blockReason: blockReason ?? "unknown",
  };
}
