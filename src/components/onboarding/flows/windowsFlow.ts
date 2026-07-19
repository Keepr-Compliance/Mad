/**
 * Windows Onboarding Flow Definition
 *
 * Defines the step order for Windows platform onboarding.
 * This flow includes Windows-specific steps like Apple Mobile Device driver setup.
 *
 * @module onboarding/flows/windowsFlow
 */

import type { OnboardingStepId, Platform } from "../types";

/**
 * The platform this flow is designed for.
 */
export const WINDOWS_PLATFORM: Platform = "windows";

/**
 * Ordered list of step IDs for the Windows onboarding flow.
 *
 * Flow order:
 * 1. phone-type - Select iPhone or Android
 * 2. android-download - Download Keepr Companion APK (only when phoneType === "android")
 * 3. android-coming-soon - Android QR pairing (only when phoneType === "android")
 * 4. apple-driver - Install Apple Mobile Device USB Driver (for iPhone users, triggers DB init)
 * 5. account-verification - Verify user exists in local DB (creates if missing, auto-retries on failure)
 * 6. contact-source - Select which contact sources to sync (Outlook only on Windows)
 * 7. email-connect - Connect email account (Google or Microsoft, DB and user are ready)
 * 8. data-sync - Sync checkpoint: pulls phone_type from Supabase to local DB (consistency with macOS)
 * 9. data-source-floor - Integrity floor (BACKLOG-1821): only shown if the user
 *    reached the end with ZERO connected data sources (no texts AND no email);
 *    otherwise non-applicable and invisible. This is the primary gap on Windows,
 *    which has no permissions/FDA terminal step — a skip-driver + skip-email user
 *    would otherwise finish data-sync and complete with nothing to audit.
 *
 * Note: apple-driver is placed before email-connect to ensure database initialization
 * happens before email OAuth. For Android users, the apple-driver step is skipped
 * via shouldSkipStep() logic in stepDerivation.ts.
 */
export const WINDOWS_FLOW_STEPS: readonly OnboardingStepId[] = [
  "phone-type",
  "android-download",
  "android-coming-soon",
  "apple-driver",
  "account-verification",
  "contact-source",
  "email-connect",
  "data-sync",
  "data-source-floor",
] as const;

/**
 * Windows flow configuration object.
 * Combines platform identifier with ordered step list.
 */
export const WINDOWS_FLOW = {
  platform: WINDOWS_PLATFORM,
  steps: WINDOWS_FLOW_STEPS,
} as const;
