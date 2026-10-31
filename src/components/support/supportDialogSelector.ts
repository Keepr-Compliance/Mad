/**
 * The support form's test id and DOM selector, in one place (BACKLOG-3964).
 *
 * The form (SupportTicketDialog) is mounted at the app root above Settings and
 * the account panel. Both layers defer Esc (and the panel defers Tab) to it
 * while it is open, by looking for this element.
 */
export const SUPPORT_DIALOG_TEST_ID = "support-ticket-dialog";
export const SUPPORT_DIALOG_SELECTOR = `[data-testid="${SUPPORT_DIALOG_TEST_ID}"]`;

/** True while the support form is in the document. */
export function isSupportFormOpen(): boolean {
  return !!document.querySelector(SUPPORT_DIALOG_SELECTOR);
}
