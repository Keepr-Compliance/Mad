import React from "react";
import {
  WINDOWS_ARM64_UNSUPPORTED_BODY,
  WINDOWS_ARM64_UNSUPPORTED_HEADING,
} from "../../constants/windowsArm64Copy";

/**
 * BACKLOG-3363: "iPhone USB sync isn't supported on this PC" — shown on Windows
 * on ARM PCs in place of every connect / Trust / install-driver surface.
 * Informational only: no buttons.
 */
export function WindowsArm64Unsupported({
  variant = "full",
}: {
  variant?: "full" | "compact";
}): React.ReactElement {
  if (variant === "compact") {
    return (
      <div
        className="p-3 bg-gray-50 rounded border border-gray-200 text-xs text-gray-700"
        data-testid="windows-arm64-unsupported"
      >
        <p className="font-medium mb-1">{WINDOWS_ARM64_UNSUPPORTED_HEADING}</p>
        <p>{WINDOWS_ARM64_UNSUPPORTED_BODY}</p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center justify-center p-8 text-center"
      data-testid="windows-arm64-unsupported"
    >
      <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </div>
      <h3 className="text-xl font-semibold text-gray-800">
        {WINDOWS_ARM64_UNSUPPORTED_HEADING}
      </h3>
      <p className="text-gray-500 mt-2 max-w-sm">
        {WINDOWS_ARM64_UNSUPPORTED_BODY}
      </p>
    </div>
  );
}

export default WindowsArm64Unsupported;
