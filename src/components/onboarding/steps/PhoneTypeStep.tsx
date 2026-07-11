/**
 * PhoneTypeStep
 *
 * First step in the onboarding flow. Asks users what type of phone
 * they use for their real estate business.
 *
 * @module onboarding/steps/PhoneTypeStep
 */

import React from "react";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
} from "../types";

// =============================================================================
// SVG ICONS
// =============================================================================

/** Phone icon for header */
const PhoneIcon: React.FC = () => (
  <svg
    className="w-8 h-8 text-blue-600"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
    />
  </svg>
);

/** Apple logo for iPhone card */
const AppleLogo: React.FC = () => (
  <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
  </svg>
);

/** Android logo for Android card */
const AndroidLogo: React.FC = () => (
  <svg className="w-7 h-7 text-white" viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.463 11.463 0 00-8.94 0L5.65 5.67c-.19-.29-.54-.38-.84-.22-.3.16-.42.54-.26.85L6.4 9.48A10.78 10.78 0 002 18h20a10.78 10.78 0 00-4.4-8.52zM7 15.25a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5zm10 0a1.25 1.25 0 110-2.5 1.25 1.25 0 010 2.5z" />
  </svg>
);

/** Info icon for footer info box */
const InfoIcon: React.FC = () => (
  <svg
    className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

/** Checkmark icon for selected state */
const CheckIcon: React.FC = () => (
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
);

// =============================================================================
// STEP METADATA
// =============================================================================

/**
 * Step metadata for PhoneTypeStep.
 * This is the first step in the onboarding flow.
 */
export const meta: OnboardingStepMeta = {
  id: "phone-type",
  progressLabel: "Phone Type",
  platforms: ["macos", "windows"],
  navigation: {
    showBack: false, // First step - no back button
    hideContinue: true, // Selection auto-advances
  },
  // skip is undefined = step cannot be skipped (required)
  isStepComplete: (context) => context.phoneType !== null,
  // Only show if phone type not yet selected
  shouldShow: (context) => context.phoneType === null,
  // Queue predicates
  isApplicable: () => true,
  isComplete: (context) => context.phoneType !== null,
};

// =============================================================================
// STEP CONTENT
// =============================================================================

/**
 * PhoneTypeStep content component.
 * Renders the phone selection UI without shell components.
 */
const Content: React.FC<OnboardingStepContentProps> = ({
  context,
  onAction,
}) => {
  const handleSelectIPhone = () => {
    onAction({ type: "SELECT_PHONE", payload: { phoneType: "iphone" } });
  };

  const handleSelectAndroid = () => {
    onAction({ type: "SELECT_PHONE", payload: { phoneType: "android" } });
  };

  const selectedType = context.phoneType;

  return (
    <>
      {/* Header */}
      <div className="text-center mb-6 sm:mb-8">
        <div className="w-14 h-14 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-3">
          <PhoneIcon />
        </div>
        <h1 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">
          What phone do you use?
        </h1>
        <p className="text-sm text-gray-600">
          Keepr can sync your text messages and contacts to help track
          real estate communications.
        </p>
      </div>

      {/* Phone Selection Cards - stack on mobile, side by side on sm+ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 sm:mb-8">
        {/* iPhone Option */}
        <button
          onClick={handleSelectIPhone}
          data-testid="onboarding-phone-iphone"
          className={`relative p-4 rounded-xl border-2 transition-all duration-200 text-left min-h-[44px] ${
            selectedType === "iphone"
              ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200"
              : "border-gray-200 hover:border-blue-400 hover:bg-blue-50 active:bg-blue-50"
          }`}
        >
          {/* Checkmark for selected */}
          {selectedType === "iphone" && (
            <div className="absolute top-3 right-3">
              <div className="w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
                <CheckIcon />
              </div>
            </div>
          )}

          <div className="flex sm:block items-center gap-3">
            {/* Apple Logo */}
            <div className="w-12 h-12 bg-gray-900 rounded-xl flex items-center justify-center flex-shrink-0 sm:mb-4">
              <AppleLogo />
            </div>

            <div>
              <h3 className="font-semibold text-gray-900 mb-0.5 sm:mb-1">iPhone</h3>
              <p className="text-sm text-gray-500">
                Sync messages and contacts from your iPhone
              </p>
            </div>
          </div>
        </button>

        {/* Android Option */}
        <button
          onClick={handleSelectAndroid}
          data-testid="onboarding-phone-android"
          className={`relative p-4 rounded-xl border-2 transition-all duration-200 text-left min-h-[44px] ${
            selectedType === "android"
              ? "border-green-500 bg-green-50 ring-2 ring-green-200"
              : "border-gray-200 hover:border-green-400 hover:bg-green-50 active:bg-green-50"
          }`}
        >
          {/* Checkmark for selected */}
          {selectedType === "android" && (
            <div className="absolute top-3 right-3">
              <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                <CheckIcon />
              </div>
            </div>
          )}

          <div className="flex sm:block items-center gap-3">
            {/* Android Logo */}
            <div className="w-12 h-12 bg-green-500 rounded-xl flex items-center justify-center flex-shrink-0 sm:mb-4">
              <AndroidLogo />
            </div>

            <div>
              <h3 className="font-semibold text-gray-900 mb-0.5 sm:mb-1">Android</h3>
              <p className="text-sm text-gray-500">
                Samsung, Google Pixel, and other Android phones
              </p>
            </div>
          </div>
        </button>
      </div>

      {/* Info Box */}
      <div className="bg-gray-50 rounded-lg p-3 sm:p-4">
        <div className="flex items-start gap-3">
          <InfoIcon />
          <p className="text-sm text-gray-600">
            Your phone data stays private and secure. We only sync the data you
            explicitly choose to share.
          </p>
        </div>
      </div>
    </>
  );
};

// =============================================================================
// STEP EXPORT
// =============================================================================

/**
 * PhoneTypeStep - Complete step definition
 */
const PhoneTypeStep: OnboardingStep = { meta, Content };

export default PhoneTypeStep;
