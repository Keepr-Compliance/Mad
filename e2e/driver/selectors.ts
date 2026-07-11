/**
 * Centralized selectors for the Keepr renderer, consumed by the Playwright-Electron
 * driver (BACKLOG-1849 / hardened by BACKLOG-1940).
 *
 * Selector strategy (in priority order), grounded in a full renderer audit:
 *   1. `data-testid`  — the PREFERRED, stable selector. BACKLOG-1940 added testids to
 *      every screen the driver navigates (onboarding, dashboard nav, settings, the
 *      transactions list + rows + empty state). Use `Testids.*` below.
 *   2. `data-action`  — react-joyride's OWN stable attribute for the feature-tour Skip/Next
 *      controls. The library does not let us inject a testid onto its internal buttons, so
 *      `data-action="skip"` / `data-action="primary"` are the sanctioned selectors there.
 *   3. role + accessible name / unique text — ONLY for third-party or transient surfaces
 *      that have no testid (e.g. the login wall, which is intentionally not tagged).
 *
 * After BACKLOG-1940 the driver's navigation helpers (gotoSettings, gotoTransactions,
 * clickFirstTransaction, dismissTour) are built ENTIRELY on `Testids`/`TourActions`, so a
 * missing testid surfaces as a HARNESS_ERROR (see outcome.ts) rather than a silent miss.
 */

/** Shared prefix for per-row transaction testids (tx-row-0, tx-row-1, …). */
export const TX_ROW_PREFIX = 'tx-row-';

/**
 * Stable data-testid values added by BACKLOG-1940. Kept in ONE place so the renderer and
 * the driver can never drift. Documented in docs/qa/driver-testids.md.
 */
export const Testids = {
  // Onboarding
  onboardingPhoneIphone: 'onboarding-phone-iphone',
  onboardingPhoneAndroid: 'onboarding-phone-android',
  onboardingContinue: 'onboarding-continue',
  onboardingBack: 'onboarding-back',
  onboardingSkip: 'onboarding-skip',
  onboardingSkipConfirm: 'onboarding-skip-confirm',
  onboardingSecureStorageContinue: 'onboarding-secure-storage-continue',
  onboardingContactsContinue: 'onboarding-contacts-continue',
  onboardingPermissionsOpenSettings: 'onboarding-permissions-open-settings',
  onboardingPermissionsCheck: 'onboarding-permissions-check',
  onboardingEmailConnectPrimary: 'onboarding-email-connect-primary',
  onboardingEmailConnectSecondary: 'onboarding-email-connect-secondary',
  // Dashboard nav
  navProfile: 'nav-profile',
  navSettings: 'nav-settings',
  navNewAudit: 'nav-new-audit',
  navTransactions: 'nav-transactions',
  navClientsContacts: 'nav-clients-contacts',
  // Settings
  settingsPage: 'settings-page',
  settingsClose: 'settings-close',
  settingsTabs: 'settings-tabs',
  /** Per-tab testid, e.g. settingsTab('general') => 'settings-tab-general'. */
  settingsTab: (name: string): string => `settings-tab-${name}`,
  // Transactions list
  txList: 'tx-list',
  txRows: 'tx-rows',
  txEmpty: 'tx-empty',
  /** Per-row testid, e.g. txRow(0) => 'tx-row-0'. */
  txRow: (index: number): string => `${TX_ROW_PREFIX}${index}`,
  // Transactions list selection / bulk (BACKLOG-1976, P2-F1 — attribute-only additions in src/)
  /** TransactionsToolbar Edit/Done toggle (enters/exits selection mode). One button; text flips. */
  txSelectionToggle: 'tx-selection-toggle',
  /** BulkActionBar Delete (rendered TWICE — mobile + desktop; resolve the VISIBLE one). */
  bulkDeleteButton: 'bulk-delete-button',
  /** BulkDeleteConfirmModal confirm button. */
  bulkDeleteConfirm: 'bulk-delete-confirm',
  /** Single-transaction DeleteConfirmModal confirm button. */
  deleteTransactionConfirm: 'delete-transaction-confirm',
} as const;

/**
 * react-joyride's stable per-button `data-action` attribute values. Used for the feature-tour
 * Skip/Next controls, which the library renders and which we cannot tag with a testid.
 */
export const TourActions = {
  skip: '[data-action="skip"]',
  primary: '[data-action="primary"]', // "Next" / "Done"
  back: '[data-action="back"]',
} as const;

/** The feature-tour is present when its intro copy is on screen. */
export const TourMarkers = {
  visibleText: /Welcome to Keepr|Step 1 of/i,
} as const;

/** The login wall (Sign in with Browser). Intentionally NOT tagged — text is the contract. */
export const LoginWall = {
  visibleText: /Sign in with Browser|Real Estate Compliance Made Simple|Start your 14-day free trial/i,
} as const;

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

/**
 * Add-users-with-roles flow testids (BACKLOG-1949). The trigger `editContactsButton` was ADDED to the
 * LIVE overview-tab button (TransactionDetailsTab) — the pre-existing copy in TransactionContactsTab is
 * DEAD UI (the Contacts tab is commented out in TransactionTabs). Everything else already existed.
 */
export const Contacts = {
  /** Overview-tab "Edit Contacts" button → opens EditContactsModal. */
  editContactsButton: 'edit-contacts-button',
  /** Screen 1 → open the "Add Contacts" overlay (Screen 2). */
  addContactsButton: 'add-contacts-button',
  /** Screen 1 empty-state variant of the add button. */
  emptyStateAddButton: 'empty-state-add-button',
  /** Screen 2 overlay container. */
  addContactsOverlay: 'add-contacts-overlay',
  /** Screen 2 "Add Selected" confirm (desktop). */
  addSelectedButton: 'add-selected-button',
  /** Screen 1 assigned-rows container. */
  assignedContactsList: 'assigned-contacts-list',
  /** EditContactsModal "Save Changes". */
  saveButton: 'edit-contacts-modal-save',
  /** Per-contact assigned row (Screen 1), e.g. contactRoleRow('id') => 'contact-role-row-id'. */
  contactRoleRow: (id: string): string => `contact-role-row-${id}`,
  /** Per-contact role <select> (Screen 1). Rendered twice (mobile + desktop) — resolve the VISIBLE one. */
  roleSelect: (id: string): string => `role-select-${id}`,
  /** Screen 2 selection row (ContactRow); target a SPECIFIC contact via the additive data-contact-id
   *  attribute on the row whose testid is `contact-row` (a raw CSS selector, not a testid). */
  selectRowByContactId: (id: string): string => `[data-testid="contact-row"][data-contact-id="${id}"]`,
  // ---- BACKLOG-1978 (remove-contact cell) ----
  /** Per-contact per-chip REMOVE button on an assigned ContactRoleRow (Screen 1), e.g.
   *  removeContactButton('id') => 'remove-contact-id'. PRE-EXISTING testid on ContactRoleRow's onRemove
   *  button (rendered twice: mobile + desktop) — the driver resolves the VISIBLE one. */
  removeContactButton: (id: string): string => `remove-contact-${id}`,
} as const;

/**
 * BACKLOG-1948: the New Audit CREATE wizard (StartNewAuditModal → AuditTransactionModal).
 *
 * Testids added attribute-only in src/ so the driver can target the create flow deterministically:
 *   - StartNewAuditModal: start-new-audit-modal / create-manually-button (pre-existing, BACKLOG-1940-era).
 *   - AuditTransactionModal step 1 (AddressVerificationStep): the address input, the purchase/sale type
 *     buttons, and the three date inputs (create-audit-* below).
 *   - The wizard footer primary button (create-audit-submit) — SAME testid across all steps (its text
 *     changes "Continue →" → "Create Transaction" but the id is stable). Rendered TWICE (mobile +
 *     desktop), so the driver resolves the VISIBLE one (matching the address-toggle pattern).
 *   - Step 2 (ContactSearchList → ContactRow): the seeded contact row carries data-contact-id, so it is
 *     selected via `[data-testid="contact-row"][data-contact-id="<id>"]` (contactRow() below).
 *   - Step 3 (ContactRoleRow): the role <select> (role-select-<id>, pre-existing).
 */
export const CreateAudit = {
  startModalTestId: 'start-new-audit-modal',
  createManuallyTestId: 'create-manually-button',
  addressInputTestId: 'create-audit-address-input',
  startDateInputTestId: 'create-audit-start-date-input',
  closingDateInputTestId: 'create-audit-closing-date-input',
  endDateInputTestId: 'create-audit-end-date-input',
  typePurchaseTestId: 'create-audit-type-purchase',
  typeSaleTestId: 'create-audit-type-sale',
  submitTestId: 'create-audit-submit',
  backTestId: 'create-audit-back',
  step2TestId: 'contact-assignment-step-2',
  step3TestId: 'contact-assignment-step-3',
  /**
   * ANY contact row in the step-2 ContactSearchList (ContactRow renders data-testid="contact-row"
   * with data-contact-id={contact.id} and data-testid="contact-row-name" holding the display name).
   * BACKLOG-1948: the cell selects a row by VISIBLE NAME (see contactRow) or the first row — NOT by
   * a literal seed id — so it is independent of the contact-ID scheme (BACKLOG-1949 makes ids UUIDs).
   */
  contactRowAny: '[data-testid="contact-row"]',
  /** The name label inside a ContactRow — used to select a row by its visible display name. */
  contactRowName: 'contact-row-name',
  /** A contact row selected by its stable contact id (retained for callers that still have one). */
  contactRow: (contactId: string): string => `[data-testid="contact-row"][data-contact-id="${contactId}"]`,
  /**
   * The step-3 role <select> for a contact (data-testid={`role-select-${contact.id}`}). Since step 2
   * selects exactly ONE contact, step 3 renders exactly ONE role-select; the driver targets it by this
   * PREFIX (not a literal id) so it stays ID-agnostic (BACKLOG-1948 / BACKLOG-1949). */
  roleSelectAny: '[data-testid^="role-select-"]',
  /** The step-3 role <select> for a specific contact id (retained for id-based callers). */
  roleSelect: (contactId: string): string => `role-select-${contactId}`,
  /** The role <option> value that satisfies the step-3 Client gate (useAuditSteps: contactAssignments.client). */
  clientRoleValue: 'client',
} as const;

/**
 * BACKLOG-1948: the Transaction Details modal (src/components/TransactionDetails.tsx →
 * ResponsiveModal, testId added attribute-only). After "Create Transaction" the app auto-opens
 * this modal over the (already-open) transactions list; its `fixed inset-0 z-[60]` overlay
 * intercepts pointer events, so the driver must DISMISS it before interacting with the list.
 * The close control (TransactionHeader) carries `transaction-details-close` on BOTH the desktop
 * X button and the mobile Back button, so it is targetable ID-agnostically.
 */
export const TransactionDetailsView = {
  overlayTestId: 'transaction-details-modal',
  closeTestId: 'transaction-details-close',
} as const;

/**
 * BACKLOG-1976 (P2-F1): cross-cutting selector groups the Phase-2 cells share. All target testids
 * that ALREADY existed (nav-clients-contacts, tx-row-*) or were added attribute-only in this task
 * (tx-selection-toggle, bulk-delete-*, delete-transaction-confirm, the stable data-tx-id on the row
 * root). Additive only — no existing group changed.
 */
export const Nav = {
  /** Dashboard "Clients & Contacts" card → opens the standalone Contacts module (showContacts). */
  clientsContacts: Testids.navClientsContacts,
} as const;

export const TxList = {
  /** The tx-list container (present whether the list is empty or not). */
  container: Testids.txList,
  /** A row by its INDEX (shifts with filter/sort), e.g. rowByIndex(0) => 'tx-row-0'. */
  rowByIndex: (index: number): string => Testids.txRow(index),
  /**
   * A row by its STABLE transaction id (BACKLOG-1976). The row root carries both
   * data-testid="tx-row-<index>" and data-tx-id="<uuid>" (mirrors ContactRow's data-contact-id),
   * so a cell can target a specific transaction independent of its list position. Raw CSS selector.
   */
  rowByTxId: (txId: string): string => `[data-testid^="${TX_ROW_PREFIX}"][data-tx-id="${txId}"]`,
  /** TransactionsToolbar Edit/Done toggle — enters/exits selection (bulk) mode. */
  selectionToggle: Testids.txSelectionToggle,
} as const;

export const BulkDelete = {
  /** BulkActionBar Delete (mobile + desktop copies — resolve the VISIBLE one). */
  deleteButton: Testids.bulkDeleteButton,
  /** BulkDeleteConfirmModal confirm. */
  confirm: Testids.bulkDeleteConfirm,
  /** Single-transaction DeleteConfirmModal confirm. */
  singleConfirm: Testids.deleteTransactionConfirm,
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
