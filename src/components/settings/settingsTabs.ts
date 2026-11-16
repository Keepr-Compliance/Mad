/**
 * Settings tabs (BACKLOG-3964).
 *
 * One list for every surface that shows the Settings sections: the Settings
 * page's tab strip today, and the account side panel's rows in slice 3. Both
 * read `visibleSettingsTabs()`, so a tab that is gated (AI) is gated in both.
 */

export interface SettingsTab {
  /** Element id of the section on the Settings page. */
  id: string;
  label: string;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  // BACKLOG-3964: Account is the first tab and the top of the page.
  { id: "settings-account", label: "Account" },
  { id: "settings-general", label: "General" },
  { id: "settings-email", label: "Email" },
  { id: "settings-messages", label: "Messages" },
  // BACKLOG-3423: no "iPhone Sync" nav entry, for any user on any platform.
  // BACKLOG-3156 stage G: the iPhone USB toggle now sits in the Messages
  // section's iPhone pane (shown when iPhone is the selected source); the
  // iPhone Sync SECTION (#settings-iphone-sync) remains on Windows only,
  // for the Apple driver tools, grayed out unless the import source is iPhone.
  { id: "settings-contacts", label: "Contacts" },
  // BACKLOG-4120: shown only when the strict autodetect_eval read is "allowed".
  { id: "settings-learn", label: "Help Keepr learn" },
  // BACKLOG-4243: shown only when main reports the Keepr Cloud section visible.
  { id: "settings-cloud", label: "Keepr Cloud" },
  { id: "settings-ai", label: "AI" },
  { id: "settings-security", label: "Security" },
  { id: "settings-data", label: "Data & Privacy" },
  { id: "settings-troubleshooting", label: "Troubleshooting" },
  // BACKLOG-2393: time-boxed support access, its consent record, and the
  // list of diagnostic reports captured under it.
  { id: "settings-support-access", label: "Support Access" },
  { id: "settings-about", label: "About" },
];

/**
 * The tabs this user sees: AI only with the AI add-on (BACKLOG-462); "Help
 * Keepr learn" only when the strict autodetect_eval read is "allowed"
 * (BACKLOG-4120). The two are independent: Learn mode never needs AI.
 */
export function visibleSettingsTabs(
  hasAIAddon: boolean,
  learnAvailable: boolean = false,
  cloudVisible: boolean = false,
): SettingsTab[] {
  return SETTINGS_TABS.filter(
    (t) =>
      (t.id !== "settings-ai" || hasAIAddon) &&
      (t.id !== "settings-learn" || learnAvailable) &&
      (t.id !== "settings-cloud" || cloudVisible),
  );
}
