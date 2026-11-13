/**
 * Leaves the portal for the AI app's return address (BACKLOG-4238). Its own
 * module so the consent form's navigation can be observed in tests.
 */

export function leaveTo(location: string): void {
  window.location.replace(location);
}
