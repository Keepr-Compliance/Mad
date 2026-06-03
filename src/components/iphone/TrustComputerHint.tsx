import React from "react";

/**
 * TrustComputerHint Component
 * Displays the steps iOS requires on every iPhone sync session.
 * iOS prompts for unlock/trust/passcode each new pairing — not just the first time.
 */
export const TrustComputerHint: React.FC = () => {
  return (
    <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-200 rounded-lg mt-4 w-full max-w-sm text-left">
      {/* Info Icon */}
      <div className="flex-shrink-0">
        <svg
          className="w-5 h-5 text-blue-500"
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
      </div>
      <div className="flex-1">
        <p className="font-medium text-blue-800 text-left">Don&apos;t see your iPhone? Try these steps:</p>
        <ol className="text-sm text-blue-700 mt-2 space-y-1 text-left list-none p-0 m-0">
          <li>1. Unlock your iPhone</li>
          <li>2. Tap &quot;Trust&quot; when prompted (iOS asks every session)</li>
          <li>3. Enter your iPhone passcode</li>
        </ol>
      </div>
    </div>
  );
};

export default TrustComputerHint;
