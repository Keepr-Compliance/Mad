import React from "react";
import type { UserFacingError } from "../../types/iphone";

/** BACKLOG-3953: the code main sends when an iPhone tool never started (Windows). */
export const TOOL_BLOCKED_CODE = "SECURITY_SOFTWARE_BLOCKED";

/** True only for the tool-blocked message; every other code keeps its existing view. */
export function isToolBlockedError(userError: UserFacingError | null | undefined): userError is UserFacingError {
  return userError?.code === TOOL_BLOCKED_CODE;
}

/**
 * BACKLOG-3996: the code main sends when a short iPhone query did not answer within its
 * time limit. Mirrored from electron/services/diagnostics/userFacingErrors.ts (the
 * renderer cannot value-import from electron/).
 */
export const IPHONE_TOOL_TIMEOUT_CODE = "IPHONE_TOOL_TIMEOUT";

/** BACKLOG-3996: the sync error codes whose message is a title, numbered steps and a closing line. */
const STEPS_NOTICE_CODES: ReadonlySet<string> = new Set([TOOL_BLOCKED_CODE, IPHONE_TOOL_TIMEOUT_CODE]);

/**
 * BACKLOG-3996: true for an error the sync screen shows as title + steps + closing line
 * (the tool-blocked and the tool-timeout messages). The connection view still uses
 * `isToolBlockedError` only: a time-out happens during a sync, not before one.
 */
export function isStepsNoticeError(userError: UserFacingError | null | undefined): userError is UserFacingError {
  return userError !== null && userError !== undefined && STEPS_NOTICE_CODES.has(userError.code);
}

/**
 * BACKLOG-3953: the restore steps for a blocked iPhone tool. BACKLOG-3996: also the
 * steps for an iPhone query that timed out — same shape, its own words. `actionSuggestion` carries
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
