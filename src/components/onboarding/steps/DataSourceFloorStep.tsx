/**
 * DataSourceFloorStep (BACKLOG-1821)
 *
 * Onboarding integrity floor — a recovery screen that appears ONLY when the user
 * has reached the end of onboarding without connecting a single data source
 * (no mailbox AND no text-message source). It closes the "completed with zero
 * sources" gap (notably Windows-iPhone: skip driver + skip email would otherwise
 * finish with nothing to audit).
 *
 * Behavior:
 *   - Applicable ONLY when `!hasMinimumDataSource(context)` — so it is invisible
 *     (skipped) for everyone who already connected a source: zero UX change for
 *     the happy path.
 *   - Complete when `hasMinimumDataSource(context)` becomes true — so it
 *     auto-drops out of the queue the instant a source connects, and onboarding
 *     completes normally.
 *   - It has NO skip and NO Continue button, and its CTAs dispatch only
 *     source-connecting / back-navigation actions (never NAVIGATE_NEXT). This is
 *     deliberate: NAVIGATE_NEXT / a Continue click would let the queue mark this
 *     step manually-complete and defeat the floor (see useOnboardingQueue
 *     manuallyCompletedIds handling).
 *
 * Copy is intentionally non-shaming: a texts-only setup is a valid, fully
 * supported state. The screen frames "connect at least one source" as help, not
 * a penalty, and points email-blocked users at the "Request IT approval" flow
 * (BACKLOG-2007) which lives in EmailConnectStep.
 *
 * This is a static CTA screen with no effects (so no StrictMode didMount-guard
 * concerns). Any diagnostics use src/utils/logger, never console.log.
 *
 * @module onboarding/steps/DataSourceFloorStep
 */

import React from "react";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
} from "../types";
import { hasMinimumDataSource } from "../queue/dataSourceFloor";
import logger from "../../../utils/logger";

// =============================================================================
// STEP META
// =============================================================================

export const meta: OnboardingStepMeta = {
  id: "data-source-floor",
  progressLabel: "Connect a source",
  // Non-empty platforms required by the step registry (steps.test.tsx). The
  // step is appended to both the macOS and Windows flows; linux reuses the
  // macOS flow, so include it too for consistency with flows/index.ts.
  platforms: ["macos", "windows", "linux"],
  navigation: {
    showBack: false,
    // No Continue button — the ONLY way past this step is to connect a source,
    // which drops the step from the queue (isComplete). A Continue click would
    // manually-complete the step and bypass the floor.
    hideContinue: true,
  },
  // Not skippable — this is the whole point of the floor.
  skip: undefined,
  // Continue is hidden, but keep canProceed false as a belt-and-suspenders guard
  // so no code path can advance past the floor without a real source.
  canProceed: () => false,
  // Queue predicates: applicable ONLY when the floor is unmet; complete the
  // instant a source connects (so it auto-drops and onboarding finishes).
  isApplicable: (context) => !hasMinimumDataSource(context),
  isComplete: (context) => hasMinimumDataSource(context),
};

// =============================================================================
// ICONS
// =============================================================================

function LinkIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
      />
    </svg>
  );
}

// =============================================================================
// CONTENT COMPONENT
// =============================================================================

/**
 * Returns the platform-appropriate label + action for the "set up text messages"
 * CTA. NAVIGATE_BACK routes the user to the preceding texts-relevant step
 * (permissions on macOS / apple-driver on Windows / android pairing) — it uses
 * goToPrevious (back-override), never goToNext, so it cannot manually-complete
 * the floor.
 */
function textsCta(context: OnboardingStepContentProps["context"]): {
  label: string;
  hint: string;
} {
  if (context.phoneType === "android") {
    return {
      label: "Set up text messages",
      hint: "Pair the Keepr Companion app to sync your Android texts.",
    };
  }
  // Default / iPhone path (both platforms).
  return {
    label: "Set up text messages",
    hint: "Go back to connect your phone's text messages.",
  };
}

/**
 * DataSourceFloorStep content — the "connect at least one source" recovery screen.
 */
export function Content({
  context,
  onAction,
}: OnboardingStepContentProps): React.ReactElement {
  const primaryProvider: "google" | "microsoft" =
    context.authProvider === "microsoft" ? "microsoft" : "google";
  const providerLabel = primaryProvider === "google" ? "Gmail" : "Outlook";

  const texts = textsCta(context);

  const handleConnectEmail = () => {
    logger.info("[DataSourceFloorStep] User chose Connect email from floor");
    // Start OAuth in place. On success, emailConnected -> true, the floor's
    // isComplete flips, the step drops from the queue, and onboarding completes.
    onAction({ type: "CONNECT_EMAIL_START", payload: { provider: primaryProvider } });
  };

  const handleSetUpTexts = () => {
    logger.info("[DataSourceFloorStep] User chose Set up texts from floor");
    // Route back to the preceding texts-relevant step. Uses goToPrevious.
    onAction({ type: "NAVIGATE_BACK" });
  };

  return (
    <div className="max-w-2xl mx-auto" data-testid="onboarding-data-source-floor">
      {/* Header */}
      <div className="text-center mb-5">
        <div className="inline-flex items-center justify-center w-14 h-14 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full mb-4 shadow-lg">
          <LinkIcon className="w-7 h-7 text-white" />
        </div>
        <h1 className="text-xl font-bold text-gray-900 mb-2">
          Connect at least one source
        </h1>
        <p className="text-sm text-gray-600">
          Keepr audits your client communications, so it needs at least one
          source to work — your text messages, your email, or both.
        </p>
      </div>

      {/* Texts-only reassurance — must NOT shame a texts-only setup */}
      <div className="mb-5 bg-green-50 border border-green-200 rounded-lg p-3">
        <p className="text-sm text-green-800">
          <strong>Text messages alone are enough.</strong> A texts-only setup is
          fully supported — you don&apos;t need to connect email to get a
          complete, auditable record. Connect email too if you want your email
          history included.
        </p>
      </div>

      {/* Source choices */}
      <div className="space-y-3 mb-5">
        {/* Texts CTA */}
        <button
          onClick={handleSetUpTexts}
          data-testid="onboarding-floor-setup-texts"
          className="w-full min-h-[44px] px-4 py-3 bg-white border-2 border-blue-200 hover:border-blue-400 rounded-lg text-left transition-colors"
        >
          <span className="block text-sm font-semibold text-gray-900">
            {texts.label}
          </span>
          <span className="block text-xs text-gray-500 mt-0.5">{texts.hint}</span>
        </button>

        {/* Email CTA */}
        <button
          onClick={handleConnectEmail}
          data-testid="onboarding-floor-connect-email"
          className="w-full min-h-[44px] px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white rounded-lg text-left transition-all shadow-md"
        >
          <span className="block text-sm font-semibold">
            Connect {providerLabel}
          </span>
          <span className="block text-xs text-blue-50 mt-0.5">
            Add your email so client emails are included too.
          </span>
        </button>
      </div>

      {/* BACKLOG-2007 pointer: email blocked by org IT admin consent */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
        <p className="text-xs text-amber-800" data-testid="onboarding-floor-it-approval-note">
          <strong>Work email blocked by your organization?</strong> If
          connecting your work email needs administrator approval, choose{" "}
          <em>Connect {providerLabel}</em> above — we&apos;ll show a
          &quot;Request IT approval&quot; option you can send to your IT admin.
          You can also continue with just your text messages for now.
        </p>
      </div>
    </div>
  );
}

// =============================================================================
// STEP DEFINITION & REGISTRATION
// =============================================================================

const DataSourceFloorStep: OnboardingStep = {
  meta,
  Content,
};

export default DataSourceFloorStep;
