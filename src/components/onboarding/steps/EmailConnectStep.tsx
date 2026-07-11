/**
 * Email Connection Step
 *
 * Prompts users to connect their email accounts (Gmail/Outlook) during onboarding.
 * Shows the primary email service (matching login provider) prominently,
 * with the other as optional.
 *
 * @module onboarding/steps/EmailConnectStep
 */

import React from "react";
import type {
  OnboardingStep,
  OnboardingStepMeta,
  OnboardingStepContentProps,
} from "../types";

// =============================================================================
// PROVIDER CONFIGURATION
// =============================================================================

interface ProviderConfig {
  name: string;
  icon: React.ReactNode;
  hoverBorder: string;
  hoverBg: string;
}

const PROVIDER_CONFIG: Record<"google" | "microsoft", ProviderConfig> = {
  google: {
    name: "Gmail",
    icon: (
      <svg
        className="w-6 h-6 text-red-500"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L12 9.545l8.073-6.052C21.69 2.28 24 3.434 24 5.457z" />
      </svg>
    ),
    hoverBorder: "hover:border-red-300",
    hoverBg: "hover:bg-red-50",
  },
  microsoft: {
    name: "Outlook",
    icon: (
      <svg className="w-6 h-6" viewBox="0 0 21 21" fill="none">
        {/* Microsoft 4-square logo */}
        <rect x="1" y="1" width="9" height="9" fill="#F25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
        <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
        <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
      </svg>
    ),
    hoverBorder: "hover:border-blue-300",
    hoverBg: "hover:bg-blue-50",
  },
};

// =============================================================================
// STEP META
// =============================================================================

export const meta: OnboardingStepMeta = {
  id: "email-connect",
  progressLabel: "Email",
  platforms: ["macos", "windows"],
  navigation: {
    showBack: true,
    hideContinue: true, // Provider cards have their own Connect/Continue buttons
  },
  skip: {
    enabled: true,
    label: "Skip for now",
    description: "You can connect your email later in Settings",
  },
  isStepComplete: (context) => context.emailConnected === true || context.emailSkipped,
  canProceed: (context) => context.emailConnected === true,
  // Only show if email not yet connected (or unknown during loading)
  // Using !== true means: show if false OR undefined (unknown state)
  shouldShow: (context) => context.emailConnected !== true,
  // Queue predicates
  isApplicable: () => true,
  isComplete: (context) => context.emailConnected === true || context.emailSkipped,
};

// =============================================================================
// CONTENT COMPONENT
// =============================================================================

/**
 * Renders the email connection card for a provider.
 */
function ProviderCard({
  provider,
  isPrimary,
  isConnected,
  connectedEmail,
  isLoading,
  isConnecting,
  onConnect,
  onContinue,
}: {
  provider: "google" | "microsoft";
  isPrimary: boolean;
  isConnected: boolean;
  connectedEmail: string | null;
  isLoading: boolean;
  isConnecting: boolean;
  onConnect: () => void;
  onContinue: () => void;
}) {
  const config = PROVIDER_CONFIG[provider];

  if (isPrimary) {
    // Primary provider card - larger and highlighted
    return (
      <div className="mb-4">
        <div className="p-3 sm:p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-xl border-2 border-blue-200">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-10 h-10 bg-white rounded-lg shadow-md flex items-center justify-center flex-shrink-0">
                {config.icon}
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-gray-900">
                  {config.name}
                </h4>
                {isLoading ? (
                  <p className="text-xs text-gray-500">Checking...</p>
                ) : isConnected ? (
                  <p className="text-xs text-green-600 font-medium">
                    Connected: {connectedEmail}
                  </p>
                ) : (
                  <p className="text-xs text-gray-500">
                    Recommended - matches your login
                  </p>
                )}
              </div>
            </div>
            {isConnected && (
              <div className="w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
                <svg
                  className="w-3.5 h-3.5 text-white"
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
            )}
          </div>
          {isConnected ? (
            <button
              onClick={onContinue}
              data-testid="onboarding-email-continue-primary"
              className="w-full min-h-[44px] px-4 py-2.5 bg-green-500 hover:bg-green-600 active:bg-green-700 text-white text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-2 shadow-md"
            >
              <span>Continue</span>
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
            </button>
          ) : (
            <button
              onClick={onConnect}
              disabled={isConnecting || isLoading}
              data-testid="onboarding-email-connect-primary"
              className="w-full min-h-[44px] px-4 py-2.5 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 active:from-blue-700 active:to-purple-800 text-white text-sm font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md"
            >
              {isConnecting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>Connecting...</span>
                </>
              ) : (
                <span>Connect {config.name}</span>
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Secondary provider card - smaller and optional
  return (
    <div className="mb-4">
      <p className="text-xs text-gray-500 text-center mb-2">
        Or connect another email service (optional)
      </p>
      <div className="p-3 bg-gray-50 rounded-xl border border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-9 h-9 bg-white rounded-lg shadow flex items-center justify-center flex-shrink-0">
              {config.icon}
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-gray-900">
                {config.name}
              </h4>
              {isLoading ? (
                <p className="text-xs text-gray-500">Checking...</p>
              ) : isConnected ? (
                <p className="text-xs text-green-600 font-medium">
                  Connected: {connectedEmail}
                </p>
              ) : (
                <p className="text-xs text-gray-400">Optional</p>
              )}
            </div>
          </div>
          {isConnected && (
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
          )}
        </div>
        {isConnected ? (
          <button
            onClick={onContinue}
            data-testid="onboarding-email-continue-secondary"
            className="w-full min-h-[44px] px-4 py-2 bg-green-500 hover:bg-green-600 active:bg-green-700 text-white text-sm font-semibold rounded-lg transition-all flex items-center justify-center gap-2 shadow-md"
          >
            <span>Continue</span>
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 7l5 5m0 0l-5 5m5-5H6"
              />
            </svg>
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={isConnecting || isLoading}
            data-testid="onboarding-email-connect-secondary"
            className="w-full min-h-[44px] px-4 py-2 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 active:from-blue-700 active:to-purple-800 text-white text-sm font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md"
          >
            {isConnecting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>Connecting...</span>
              </>
            ) : (
              <span>Connect {config.name}</span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Email Connect Step Content Component
 *
 * Displays provider cards for Gmail and Outlook connection.
 * The primary provider (matching auth provider) is shown prominently.
 */
export function Content({
  context,
  onAction,
}: OnboardingStepContentProps): React.ReactElement {
  // Determine primary and secondary providers based on auth provider
  const isPrimaryGoogle = context.authProvider === "google";
  const primaryProvider: "google" | "microsoft" = isPrimaryGoogle
    ? "google"
    : "microsoft";
  const secondaryProvider: "google" | "microsoft" = isPrimaryGoogle
    ? "microsoft"
    : "google";

  // Track connecting state locally (the orchestrator handles actual OAuth)
  const [connectingProvider, setConnectingProvider] = React.useState<
    "google" | "microsoft" | null
  >(null);

  // Connection status from context (convert undefined to false for boolean checks)
  const primaryConnected =
    context.emailConnected === true && context.emailProvider === primaryProvider;
  const secondaryConnected =
    context.emailConnected === true && context.emailProvider === secondaryProvider;

  // Get connected email for each provider
  const primaryEmail = primaryConnected ? context.connectedEmail : null;
  const secondaryEmail = secondaryConnected ? context.connectedEmail : null;

  // Reset connecting state when connection succeeds
  React.useEffect(() => {
    if (context.emailConnected === true) {
      setConnectingProvider(null);
    }
  }, [context.emailConnected]);

  const handleConnect = (provider: "google" | "microsoft") => {
    setConnectingProvider(provider);
    onAction({
      type: "CONNECT_EMAIL_START",
      payload: { provider },
    });
  };

  const handleContinue = () => {
    onAction({ type: "NAVIGATE_NEXT" });
  };

  return (
    <>
      {/* Header */}
      <div className="text-center mb-4 sm:mb-5">
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
              strokeWidth={2}
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        </div>
        <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-2">
          Connect Your Email
        </h2>
        <p className="text-sm text-gray-600">
          Connect your email account to export communications alongside text
          messages for complete audit trails.
        </p>
      </div>

      {/* Why connect email info box */}
      <div className="mb-5 bg-blue-50 rounded-xl p-3">
        <h3 className="text-sm font-semibold text-blue-900 mb-2">
          Why connect your email?
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
            <span>Export complete communication history with clients</span>
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
            <span>Include emails in your audit documentation</span>
          </li>
        </ul>
      </div>

      {/* Primary Provider Card */}
      <ProviderCard
        provider={primaryProvider}
        isPrimary={true}
        isConnected={primaryConnected}
        connectedEmail={primaryEmail}
        isLoading={false}
        isConnecting={connectingProvider === primaryProvider}
        onConnect={() => handleConnect(primaryProvider)}
        onContinue={handleContinue}
      />

      {/* Secondary Provider Card */}
      <ProviderCard
        provider={secondaryProvider}
        isPrimary={false}
        isConnected={secondaryConnected}
        connectedEmail={secondaryEmail}
        isLoading={false}
        isConnecting={connectingProvider === secondaryProvider}
        onConnect={() => handleConnect(secondaryProvider)}
        onContinue={handleContinue}
      />

      {/* Skip button - managed by shell via meta.skip */}
    </>
  );
}

// =============================================================================
// STEP REGISTRATION
// =============================================================================

const EmailConnectStep: OnboardingStep = {
  meta,
  Content,
};

export default EmailConnectStep;
