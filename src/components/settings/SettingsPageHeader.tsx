/**
 * SettingsPageHeader — the Settings page's one header row (BACKLOG-3964).
 *
 * "← Back", a divider, then the tabs, directly under the app title bar (which
 * says "Settings"). Replaces the gradient modal header and the "Done" footer.
 * The tab strip lives OUTSIDE the page's scroll container now, so it no longer
 * needs to be sticky.
 */
import React from "react";
import { SettingsTabBar } from "./SettingsTabBar";
import type { SettingsTab } from "./settingsTabs";

interface SettingsPageHeaderProps {
  onBack: () => void;
  tabs: SettingsTab[];
  activeTabId: string;
  onTabClick: (id: string) => void;
}

export function SettingsPageHeader({ onBack, tabs, activeTabId, onTabClick }: SettingsPageHeaderProps) {
  return (
    <div className="flex flex-none min-w-0 items-center gap-1.5 border-b border-gray-200 bg-white px-2 sm:px-3.5">
      <button
        type="button"
        onClick={onBack}
        data-testid="settings-close"
        aria-label="Back"
        className="flex flex-none items-center gap-1 rounded-md px-2 py-2 text-sm font-semibold text-gray-900 hover:bg-blue-50 sm:px-2.5"
      >
        <span aria-hidden="true">←</span>
        <span className="hidden sm:inline">Back</span>
      </button>
      <span className="h-5 w-px flex-none bg-gray-200" aria-hidden="true" />
      <SettingsTabBar tabs={tabs} activeTabId={activeTabId} onTabClick={onTabClick} />
    </div>
  );
}
