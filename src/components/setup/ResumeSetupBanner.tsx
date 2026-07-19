/**
 * ResumeSetupBanner (BACKLOG-1709 / BACKLOG-1711)
 *
 * Persistent, session-dismissable banner surfaced in the main app whenever a
 * user has reached the dashboard while still BELOW the onboarding data-source
 * floor (BACKLOG-1821) — i.e. they have no connected data source at all.
 *
 * It closes the two reported gaps together:
 *   - 1709: a user who exits onboarding with no source silently gets empty
 *     email/text threads with no explanation — this banner explains why and
 *     offers a one-click path back.
 *   - 1711: there was no affordance to return to setup once out of onboarding —
 *     this is that affordance, surfacing the capability that previously lived
 *     only in Settings.
 *
 * Show/hide is decided entirely by {@link useResumeSetup} (floor-aware), so a
 * texts-only user (a valid, non-degraded completion) never sees it. This
 * component is presentational: it renders nothing when `show` is false.
 *
 * @module components/setup/ResumeSetupBanner
 */

import React from "react";
import { AlertBanner, AlertIcons } from "../common/AlertBanner";
import { useResumeSetup } from "./useResumeSetup";
import type { AppStateMachine } from "../../appCore/state/types";

export interface ResumeSetupBannerProps {
  /** App state machine — supplies floor state + resume/dismiss actions. */
  app: AppStateMachine;
}

/**
 * Persistent "Resume setup" banner for the main app.
 * Renders null unless the data-source floor is unmet and the prompt has not
 * been dismissed this session.
 */
export function ResumeSetupBanner({ app }: ResumeSetupBannerProps): React.ReactElement | null {
  const { show, onResume, onDismiss } = useResumeSetup(app);

  if (!show) {
    return null;
  }

  return (
    <div className="flex-shrink-0 px-4 pt-3">
      <AlertBanner
        icon={AlertIcons.email}
        title="Finish setting up Keepr"
        description="Connect an email account or a text-message source so your transactions can pull in related emails and texts."
        actionText="Resume setup"
        onAction={onResume}
        dismissible
        onDismiss={onDismiss}
        testId="resume-setup-banner"
      />
    </div>
  );
}

export default ResumeSetupBanner;
