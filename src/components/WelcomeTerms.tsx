import React, { useState } from "react";
import logger from '../utils/logger';
import { PRIVACY_URL, TERMS_URL } from "../constants/legalUrls";

interface WelcomeTermsProps {
  user: {
    display_name?: string;
    email?: string;
  };
  onAccept: () => Promise<void>;
  /** @deprecated No longer used - users close app to decline */
  onDecline?: () => void;
}

/**
 * WelcomeTerms Component
 * Shows welcome message and terms acceptance for new users.
 * Appears once after first OAuth login.
 *
 * Streamlined to match onboarding step styling with:
 * - Single checkbox for Terms and Privacy
 * - Card-based layout matching other onboarding steps
 * - No decline button (users close app if they don't accept)
 */
function WelcomeTerms({ user, onAccept }: WelcomeTermsProps) {
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [accepting, setAccepting] = useState(false);

  const handleAccept = async () => {
    if (!termsAccepted) {
      return;
    }

    setAccepting(true);
    try {
      await onAccept();
    } catch (error) {
      logger.error("Failed to accept terms:", error);
      setAccepting(false);
    }
  };

  // Get display name for greeting
  const displayName = user?.display_name || user?.email?.split("@")[0] || "there";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 fixed inset-0 z-50">
      <div className="max-w-xl w-full mx-auto">
        {/* Card with responsive gap */}
        <div className="mt-4 sm:mt-6">
          {/* Step indicator - matches OnboardingShell progress style */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-semibold">
            </div>
            <span className="text-sm text-gray-600">Terms & Conditions</span>
          </div>

          {/* Main card container - matches OnboardingShell styling */}
          <div className="bg-white rounded-2xl shadow-xl p-6">
            {/* Header with icon */}
            <div className="text-center mb-5">
              <div className="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full mb-3 shadow-lg">
                <svg
                  className="w-7 h-7 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900 mb-2">
                Welcome, {displayName}!
              </h2>
              <p className="text-sm text-gray-600">
                Before we get started, please review and accept our terms.
              </p>
            </div>

            {/* Info box - 14 day trial */}
            <div className="mb-5 bg-blue-50 rounded-xl p-3">
              <div className="flex items-start gap-2">
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
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <div>
                  <p className="text-sm font-medium text-blue-900 mb-1">
                    14-Day Free Trial
                  </p>
                  <p className="text-xs text-blue-700">
                    Your trial starts now. No credit card required.
                  </p>
                </div>
              </div>
            </div>

            {/* Single checkbox for Terms & Privacy */}
            <div className="mb-5">
              <label className="flex items-start cursor-pointer group">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5 mr-3 w-5 h-5 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 group-hover:text-gray-900">
                  I accept the{" "}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      window.api?.shell?.openExternal?.(TERMS_URL);
                    }}
                    className="text-blue-600 hover:underline font-medium"
                  >
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      window.api?.shell?.openExternal?.(PRIVACY_URL);
                    }}
                    className="text-blue-600 hover:underline font-medium"
                  >
                    Privacy Policy
                  </a>
                </span>
              </label>
            </div>

            {/* Accept button - matches onboarding step button style */}
            <button
              onClick={handleAccept}
              disabled={!termsAccepted || accepting}
              className={`w-full px-4 py-2.5 rounded-lg font-semibold transition-all ${
                termsAccepted && !accepting
                  ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700 shadow-md"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
            >
              {accepting ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  Accepting...
                </span>
              ) : (
                "Accept & Continue"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WelcomeTerms;
