/**
 * AndroidDownloadStep
 *
 * Step displayed when users select Android during phone type selection,
 * BEFORE the QR pairing step. Shows a QR code linking to the broker portal
 * download page so the user can install the Keepr Companion APK on their
 * Android phone.
 *
 * BACKLOG-1479: New step to guide users through companion app installation.
 *
 * @module onboarding/steps/AndroidDownloadStep
 */

import React, { useState, useEffect } from "react";
import QRCode from "qrcode";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
} from "../types";
import logger from "../../../utils/logger";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * URL for the broker portal download page.
 * The QR code encodes this URL so users can scan it with their phone camera.
 */
const DOWNLOAD_URL = "https://app.keeprcompliance.com/download/android";

// =============================================================================
// STEP METADATA
// =============================================================================

/**
 * Step metadata configuration.
 * This step appears only for Android users and requires manual advancement.
 */
export const meta: OnboardingStepMeta = {
  id: "android-download",
  progressLabel: "Install App",
  platforms: ["macos", "windows"],
  navigation: {
    showBack: true,
    hideContinue: true, // Manual "I've installed it" button
  },
  isApplicable: (context) => context.phoneType === "android",
  isComplete: () => false, // Manual advance only
};

// =============================================================================
// STEP CONTENT
// =============================================================================

/**
 * Android Download step content.
 * Generates a QR code linking to the broker portal download page
 * and shows installation instructions.
 */
function Content({ onAction, variant = "onboarding" }: OnboardingStepContentProps) {
  // BACKLOG-2289: In the Settings wizard the 60s auto-advance is undesirable —
  // the user is deliberately (re)configuring, not being nudged through first-run.
  const autoAdvance = variant !== "settings";

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(60);

  // Countdown timer — decrements only, no side effects in state updater.
  // Disabled in the Settings variant (no auto-advance).
  useEffect(() => {
    if (!autoAdvance) return;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev <= 0 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [autoAdvance]);

  // Auto-advance when countdown reaches 0 (separate from state updater)
  useEffect(() => {
    if (!autoAdvance) return;
    if (countdown <= 0) {
      onAction({ type: "NAVIGATE_NEXT" });
    }
  }, [autoAdvance, countdown, onAction]);

  useEffect(() => {
    let cancelled = false;

    async function generateQR() {
      try {
        const dataUrl = await QRCode.toDataURL(DOWNLOAD_URL, {
          width: 200,
          margin: 2,
          color: {
            dark: "#000000",
            light: "#ffffff",
          },
        });
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      } catch (err) {
        logger.error("[AndroidDownloadStep] Failed to generate QR code:", err);
        if (!cancelled) {
          setError("Failed to generate QR code");
        }
      }
    }

    generateQR();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstalled = () => {
    onAction({ type: "NAVIGATE_NEXT" });
  };

  const handleSkip = () => {
    onAction({ type: "NAVIGATE_NEXT" });
  };

  return (
    <div className="text-center">
      {/* Download Icon */}
      <div className="relative inline-block mb-4">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
          <svg
            className="w-10 h-10 text-green-500"
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
        </div>
      </div>

      {/* Header */}
      <h1 className="text-xl font-bold text-gray-900 mb-2">
        Install Keepr Companion
      </h1>

      <p className="text-sm text-gray-600 mb-4">
        Scan this QR code with your Android phone to download the Keepr
        Companion app.
      </p>

      {/* QR Code with DOWNLOAD label to differentiate from pairing QR */}
      {qrDataUrl && (
        <div className="flex flex-col items-center mb-4">
          <div className="bg-green-50 px-3 py-1 rounded-full mb-2">
            <span className="text-xs font-bold text-green-700 uppercase tracking-wider">Download Link</span>
          </div>
          <div className="bg-white p-3 rounded-xl border-2 border-green-300 shadow-sm mb-2">
            <img
              src={qrDataUrl}
              alt="Download QR Code"
              className="w-48 h-48 sm:w-56 sm:h-56"
            />
          </div>
          {autoAdvance && (
            <p className="text-xs text-gray-400">
              Auto-continuing in {countdown}s
            </p>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-red-700 bg-red-50 p-3 rounded border border-red-200 mb-4">
          {error}
        </div>
      )}

      {/* Installation Instructions */}
      <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl p-4 mb-4 text-left">
        <h3 className="font-semibold text-gray-900 mb-2 flex items-center gap-2">
          <svg
            className="w-5 h-5 text-green-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          Installation Steps
        </h3>
        <ol className="space-y-2">
          <li className="flex items-start gap-2 text-sm text-gray-600">
            <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">
              1
            </span>
            Scan the QR code with your phone camera
          </li>
          <li className="flex items-start gap-2 text-sm text-gray-600">
            <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">
              2
            </span>
            Download and install the APK
          </li>
          <li className="flex items-start gap-2 text-sm text-gray-600">
            <span className="flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full flex items-center justify-center text-xs font-bold">
              3
            </span>
            Open the app and sign in
          </li>
        </ol>
      </div>

      {/* Action Buttons */}
      <div className="space-y-2">
        <button
          onClick={handleInstalled}
          className="w-full py-2.5 px-4 bg-green-500 text-white rounded-lg font-semibold hover:bg-green-600 transition-all shadow-md hover:shadow-lg"
        >
          I&apos;ve Installed It
        </button>

        <button
          onClick={handleSkip}
          className="w-full py-2.5 px-4 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition-all"
        >
          Skip — I already have it
        </button>
      </div>

      {/* Footer Note */}
      <p className="text-xs text-gray-400 mt-4">
        You can also download the companion app later from your broker portal.
      </p>
    </div>
  );
}

/**
 * Complete Android Download step definition.
 */
const AndroidDownloadStep: OnboardingStep = {
  meta,
  Content,
};

export default AndroidDownloadStep;
