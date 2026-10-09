/**
 * ShellBanners
 *
 * Banners mounted under the title bar. All are hidden on the login screen.
 * Extracted from AppShell to keep it within its line budget.
 */

import React from "react";
import type { AppStateMachine } from "../state/types";
import { OfflineBanner } from "./OfflineBanner";
import { ResumeSetupBanner } from "../../components/setup/ResumeSetupBanner";
import { AtRestMigrationBanner } from "../../components/common/AtRestMigrationBanner";

export function ShellBanners({
  app,
}: {
  app: AppStateMachine;
}): React.ReactElement | null {
  const { currentStep, isOnline, isChecking, handleRetryConnection } = app;
  if (currentStep === "login") return null;
  return (
    <>
      <OfflineBanner
        isOnline={isOnline}
        isChecking={isChecking}
        onRetry={handleRetryConnection}
      />
      {/* Resume Setup Banner (BACKLOG-1709 / BACKLOG-1711): self-gates on the
          onboarding data-source floor and per-session dismissal. */}
      <ResumeSetupBanner app={app} />
      <AtRestMigrationBanner />
    </>
  );
}
