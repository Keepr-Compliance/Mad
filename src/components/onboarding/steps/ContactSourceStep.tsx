/**
 * Contact Source Selection Step
 *
 * Prompts users to select which contact sources to sync during onboarding.
 * Shows platform-appropriate options:
 * - macOS: macOS Contacts App + Outlook / Microsoft 365
 * - Windows: Outlook / Microsoft 365 only
 *
 * Selected sources are saved to Supabase as contactSources.direct preferences.
 * Skipping defaults to all available sources enabled (fail-open).
 *
 * @module onboarding/steps/ContactSourceStep
 */

import React, { useState, useCallback, useMemo } from "react";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
} from "../types";
import { usePlatform } from "../../../contexts/PlatformContext";
import logger from "../../../utils/logger";

// =============================================================================
// SOURCE CONFIGURATION
// =============================================================================

interface SourceConfig {
  key: "macosContacts" | "outlookContacts" | "iphoneContacts" | "googleContacts" | "androidContacts";
  label: string;
  description: string;
  icon: React.ReactNode;
  selectedBorder: string;
  selectedBg: string;
  /** Only show on these platforms. Undefined = all platforms. */
  platforms?: ("macos" | "windows")[];
  /** Only show when user selected this phone type. Undefined = always show. */
  phoneType?: "iphone" | "android";
  /** Hide when user selected this phone type. Undefined = never hide by phone type. */
  excludePhoneType?: "iphone" | "android";
  /** Only show when user authenticated with this provider. Undefined = always show. */
  authProvider?: "google" | "microsoft";
  /** Hidden sources are registered but not shown in UI yet. */
  hidden?: boolean;
  /** Show as disabled with a "Coming Soon" badge. */
  comingSoon?: boolean;
}

const SOURCE_OPTIONS: SourceConfig[] = [
  {
    key: "macosContacts",
    label: "macOS Contacts App",
    description: "Sync contacts from the built-in macOS Contacts app",
    icon: (
      <svg
        className="w-7 h-7 text-violet-600"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
        />
      </svg>
    ),
    selectedBorder: "border-violet-400",
    selectedBg: "bg-violet-50",
    platforms: ["macos"],
    excludePhoneType: "android",
  },
  {
    key: "outlookContacts",
    label: "Outlook / Microsoft 365",
    description: "Sync contacts from your connected Microsoft account",
    icon: (
      <svg className="w-7 h-7" viewBox="0 0 21 21" fill="none">
        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
      </svg>
    ),
    selectedBorder: "border-blue-400",
    selectedBg: "bg-blue-50",
  },
  {
    key: "googleContacts",
    label: "Google Contacts",
    description: "Sync contacts from your Google account",
    icon: (
      <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 001 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
      </svg>
    ),
    selectedBorder: "border-green-400",
    selectedBg: "bg-green-50",
  },
  {
    key: "iphoneContacts",
    label: "iPhone Contacts",
    description: "Import contacts from your synced iPhone",
    icon: (
      <svg className="w-7 h-7 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
        />
      </svg>
    ),
    selectedBorder: "border-gray-400",
    selectedBg: "bg-gray-50",
    phoneType: "iphone",
  },
  {
    key: "androidContacts",
    label: "Android Phone Contacts",
    description: "Import contacts synced from your Android companion app",
    icon: (
      <svg className="w-7 h-7 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
        />
      </svg>
    ),
    selectedBorder: "border-green-400",
    selectedBg: "bg-green-50",
    phoneType: "android",
  },
];

// =============================================================================
// STEP META
// =============================================================================

export const meta: OnboardingStepMeta = {
  id: "contact-source",
  progressLabel: "Contacts",
  platforms: ["macos", "windows"],
  navigation: {
    showBack: true,
    hideContinue: true,
  },
  skip: {
    enabled: true,
    label: "I'll set this up later",
    description: "All available sources will be enabled by default",
  },
  // Step is complete once the user has proceeded (either by selecting sources or skipping)
  isStepComplete: () => false,
  canProceed: () => true,
  // Queue predicates
  isApplicable: () => true,
  isComplete: () => false, // User must interact
};

// =============================================================================
// CONTENT COMPONENT
// =============================================================================

/**
 * Renders a selectable card for a contact source.
 */
function SourceCard({
  source,
  isSelected,
  onToggle,
  isSaving,
}: {
  source: SourceConfig;
  isSelected: boolean;
  onToggle: () => void;
  isSaving: boolean;
}) {
  if (source.comingSoon) {
    return (
      <div className="w-full p-4 rounded-xl border-2 border-gray-200 bg-gray-50 text-left flex items-center gap-4 opacity-60 cursor-not-allowed">
        <div className="w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 bg-gray-100">
          {source.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-gray-500">{source.label}</h4>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded">
              Coming Soon
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">{source.description}</p>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={isSaving}
      className={`w-full p-3 sm:p-4 rounded-xl border-2 transition-all text-left flex items-center gap-3 sm:gap-4 min-h-[44px] disabled:opacity-50 disabled:cursor-not-allowed ${
        isSelected
          ? `${source.selectedBorder} ${source.selectedBg} shadow-sm`
          : "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 active:bg-gray-100"
      }`}
    >
      <div
        className={`w-12 h-12 rounded-lg flex items-center justify-center flex-shrink-0 ${
          isSelected ? "bg-white shadow-md" : "bg-gray-100"
        }`}
      >
        {source.icon}
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-semibold text-gray-900">{source.label}</h4>
        <p className="text-xs text-gray-500 mt-0.5">{source.description}</p>
      </div>
      <div className="flex-shrink-0">
        {isSelected ? (
          <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
            <svg
              className="w-4 h-4 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        ) : (
          <div className="w-6 h-6 rounded-full border-2 border-gray-300" />
        )}
      </div>
    </button>
  );
}

/**
 * Contact Source Selection Step Content Component
 *
 * Shows platform-appropriate contact source options as multi-select cards.
 * On macOS: shows both macOS Contacts and Outlook.
 * On Windows: shows Outlook only.
 */
export function Content({
  context,
  onAction,
}: OnboardingStepContentProps): React.ReactElement {
  const { isMacOS } = usePlatform();
  const [isSaving, setIsSaving] = useState(false);

  // Default selections adapt to phone type:
  // - Android: Android Contacts + Google Contacts pre-selected
  // - iPhone/null: macOS Contacts + SSO provider's contacts pre-selected
  const isAndroid = context.phoneType === "android";
  const [selected, setSelected] = useState<Record<string, boolean>>({
    macosContacts: !isAndroid,
    outlookContacts: isAndroid ? false : context.authProvider === "microsoft",
    iphoneContacts: !isAndroid,
    googleContacts: isAndroid ? true : context.authProvider === "google",
    androidContacts: isAndroid,
  });

  // Filter sources by platform, phone type, auth provider, and visibility
  const visibleSources = useMemo(
    () =>
      SOURCE_OPTIONS.filter((source) => {
        if (source.hidden) return false;
        if (source.platforms && !source.platforms.includes(isMacOS ? "macos" : "windows")) return false;
        if (source.phoneType && source.phoneType !== context.phoneType) return false;
        if (source.excludePhoneType && source.excludePhoneType === context.phoneType) return false;
        if (source.authProvider && source.authProvider !== context.authProvider) return false;
        return true;
      }),
    [isMacOS, context.phoneType, context.authProvider]
  );

  const handleToggle = useCallback((key: string) => {
    setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleContinue = useCallback(async () => {
    if (!context.userId) {
      // No user, just proceed
      onAction({ type: "NAVIGATE_NEXT" });
      return;
    }

    setIsSaving(true);
    try {
      // Build preferences object for active (non-coming-soon) visible sources only
      const directPrefs: Record<string, boolean> = {};
      for (const source of visibleSources) {
        if (source.comingSoon) continue;
        directPrefs[source.key] = selected[source.key] ?? true;
      }

      await window.api.preferences.update(context.userId, {
        contactSources: {
          direct: directPrefs,
        },
      });

      logger.info(
        "[ContactSourceStep] Saved contact source preferences:",
        directPrefs
      );
    } catch (err) {
      // Non-fatal: preferences will default to enabled (fail-open)
      logger.warn(
        "[ContactSourceStep] Failed to save preferences, continuing with defaults:",
        err
      );
    } finally {
      setIsSaving(false);
    }

    onAction({ type: "NAVIGATE_NEXT" });
  }, [context.userId, visibleSources, selected, onAction]);

  return (
    <>
      {/* Header */}
      <div className="text-center mb-5">
        <div className="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-violet-500 to-blue-600 rounded-full mb-3 shadow-lg">
          <svg
            className="w-7 h-7 text-white"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
        </div>
        <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">
          Where do you save your contacts?
        </h2>
        <p className="text-sm text-gray-600">
          Select the contact sources you use. Keepr will import contacts from
          these sources to help identify parties in your transactions.
        </p>
      </div>

      {/* Info box */}
      <div className="mb-5 bg-blue-50 rounded-xl p-3">
        <h3 className="text-sm font-semibold text-blue-900 mb-2">
          Why import contacts?
        </h3>
        <ul className="space-y-2">
          <li className="flex items-start gap-2 text-sm text-blue-800">
            <svg
              className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            <span>
              Automatically match contacts to transaction communications
            </span>
          </li>
          <li className="flex items-start gap-2 text-sm text-blue-800">
            <svg
              className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            <span>
              Identify clients, agents, and other parties in your audits
            </span>
          </li>
        </ul>
      </div>

      {/* Source cards */}
      <div className="space-y-3 mb-5">
        {visibleSources.map((source) => (
          <SourceCard
            key={source.key}
            source={source}
            isSelected={selected[source.key] ?? true}
            onToggle={() => handleToggle(source.key)}
            isSaving={isSaving}
          />
        ))}
      </div>

      {/* Continue button */}
      <button
        onClick={handleContinue}
        disabled={isSaving}
        data-testid="onboarding-contacts-continue"
        className="w-full min-h-[44px] px-4 py-2.5 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 active:from-blue-700 active:to-purple-800 text-white text-sm font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md"
      >
        {isSaving ? (
          <>
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            <span>Saving...</span>
          </>
        ) : (
          <span>Continue</span>
        )}
      </button>

      {/* Note about settings */}
      <p className="text-center text-xs text-gray-500 mt-3">
        You can change these settings anytime in Settings &gt; Contacts.
      </p>

      {/* Skip button is managed by shell via meta.skip */}
    </>
  );
}

// =============================================================================
// STEP REGISTRATION
// =============================================================================

const ContactSourceStep: OnboardingStep = {
  meta,
  Content,
};

export default ContactSourceStep;
