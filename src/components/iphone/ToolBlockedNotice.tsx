import React from "react";
import type { UserFacingError } from "../../types/iphone";

/** BACKLOG-3953: the code main sends when an iPhone tool never started (Windows). */
export const TOOL_BLOCKED_CODE = "SECURITY_SOFTWARE_BLOCKED";

/** True only for the tool-blocked message; every other code keeps its existing view. */
export function isToolBlockedError(userError: UserFacingError | null | undefined): userError is UserFacingError {
  return userError?.code === TOOL_BLOCKED_CODE;
}

/**
 * BACKLOG-3953: the restore steps for a blocked iPhone tool. `actionSuggestion` carries
 * one numbered step per line and ends with the contact-support line
 * (electron/services/diagnostics/userFacingErrors.ts formatToolBlockedError).
 */
export const ToolBlockedNotice: React.FC<{ userError: UserFacingError }> = ({ userError }) => {
  const lines = userError.actionSuggestion.split("\n").filter((line) => line.trim().length > 0);
  const steps = lines.filter((line) => /^\d+\.\s/.test(line));
  const closing = lines.filter((line) => !/^\d+\.\s/.test(line));
  return (
    <div className="max-w-md text-left" data-testid="tool-blocked-notice">
      <h3 className="text-xl font-semibold text-gray-800 text-center">{userError.title}</h3>
      <p className="text-gray-700 mt-2">{userError.description}</p>
      <ol className="list-decimal list-inside mt-3 space-y-1 text-gray-700">
        {steps.map((line) => (
          <li key={line}>{line.replace(/^\d+\.\s/, "")}</li>
        ))}
      </ol>
      {closing.map((line) => (
        <p key={line} className="text-gray-600 mt-3">
          {line}
        </p>
      ))}
    </div>
  );
};
