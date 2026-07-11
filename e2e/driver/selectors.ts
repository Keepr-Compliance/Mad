/**
 * Centralized selectors for the Keepr renderer, consumed by the Playwright-Electron
 * driver (BACKLOG-1849 / realizes BACKLOG-1789).
 *
 * Selector strategy (in priority order), grounded in a full renderer audit:
 *   1. `data-testid`  — used where the app already exposes one (e.g. the filter toggle).
 *   2. role + accessible name — for buttons/switches without a testid.
 *   3. unique visible text — last resort for onboarding/nav where no testid exists.
 *
 * Most onboarding / transaction-list / export UI currently has NO data-testid, so
 * text/role fallbacks are unavoidable today. Where that is brittle, the fix is to add
 * a `data-testid` in the renderer (tracked as a follow-up for H9's UI-regression sweep).
 */

export const RootMount = '#root';

/** Markers that distinguish the onboarding shell from the ready main app. */
export const StateMarkers = {
  /** Any of these visible => onboarding / not-yet-ready. */
  onboardingText: [
    /Connect (Outlook|Gmail)/i,
    /Get Started/i,
    /Welcome to Keepr/i,
    /What kind of phone/i,
    /Secure Storage/i,
  ],
  /** Any of these visible => the authenticated main app is showing. */
  readyText: [/Transactions?/i, /Active/i, /Closed/i, /Pending/i],
} as const;

export const Onboarding = {
  phoneTypeIphone: { role: 'button', name: /iPhone/i } as const,
  phoneTypeAndroid: { role: 'button', name: /Android/i } as const,
  continue: { role: 'button', name: /^(Continue|Next|Get Started|Accept)$/i } as const,
  back: { role: 'button', name: /^Back$/i } as const,
  skip: { role: 'button', name: /Skip( for now)?/i } as const,
  connectOutlook: { role: 'button', name: /Connect Outlook/i } as const,
  connectGmail: { role: 'button', name: /Connect Gmail/i } as const,
  openSystemSettings: { role: 'button', name: /Open System Settings/i } as const,
  checkPermissions: { role: 'button', name: /Check Permissions/i } as const,
  syncingText: /Syncing Your Data/i,
  readyText: /^Ready$/i,
} as const;

export const Transactions = {
  /** Transaction cards render the formatted address in a heading. */
  cardByAddress: (address: string) => ({ role: 'heading' as const, name: new RegExp(escapeRegExp(address), 'i') }),
  /** Pending transactions DO expose a testid: pending-transaction-{id}. */
  pendingByIdTestId: (id: string) => `pending-transaction-${id}`,
} as const;

export const Filter = {
  /** The one high-value testid on the transaction email view. role="switch" + aria-checked. */
  addressToggleTestId: 'address-filter-toggle',
  addressToggleRole: { role: 'switch', name: /(Filter by property address|Address filter)/i } as const,
} as const;

export const Exporter = {
  /** Export button lives in the transaction header (ActiveActions). No testid today. */
  exportButton: { role: 'button', name: /^Export$/i } as const,
  /** ExportModal is an in-app React modal (NOT a native dialog) until the final folder picker. */
  modalDateInputs: 'input[type="date"]',
  modalExportConfirm: { role: 'button', name: /^Export$/i } as const,
  completionText: /export completed|show in folder|Export Complete/i,
} as const;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
