/**
 * macOS Onboarding Flow Definition
 *
 * Defines the step order for macOS platform onboarding.
 * This flow includes macOS-specific steps like secure storage (Keychain) setup.
 *
 * @module onboarding/flows/macosFlow
 */

import type { OnboardingStepId, Platform } from "../types";

/**
 * The platform this flow is designed for.
 */
export const MACOS_PLATFORM: Platform = "macos";

/**
 * Ordered list of step IDs for the macOS onboarding flow.
 *
 * Flow order:
 * 1. phone-type - Select iPhone or Android
 * 2. android-download - Download Keepr Companion APK (only when phoneType === "android")
 * 3. android-coming-soon - Android QR pairing (only when phoneType === "android")
 * 4. secure-storage - Set up macOS Keychain for secure credential storage (DB init happens here)
 * 5. account-verification - Verify user exists in local DB (creates if missing, auto-retries on failure)
 * 6. contact-source - Select which contact sources to sync (macOS Contacts, Outlook)
 * 7. email-connect - Connect email account (Google or Microsoft) - DB and user are ready by this point
 * 8. data-sync - Sync checkpoint: pulls phone_type from Supabase to local DB before FDA step
 * 9. permissions - Grant required macOS permissions (Full Disk Access for Messages sync)
 * 10. data-source-floor - Integrity floor (BACKLOG-1821): only shown if the user
 *     reached the end with ZERO connected data sources (no texts AND no email);
 *     otherwise non-applicable and invisible.
 */
export const MACOS_FLOW_STEPS: readonly OnboardingStepId[] = [
  "phone-type",
  "android-download",
  "android-coming-soon",
  "secure-storage",
  "account-verification",
  "contact-source",
  "email-connect",
  "data-sync",
  "permissions",
  "data-source-floor",
] as const;

/**
 * macOS flow configuration object.
 * Combines platform identifier with ordered step list.
 */
export const MACOS_FLOW = {
  platform: MACOS_PLATFORM,
  steps: MACOS_FLOW_STEPS,
} as const;
