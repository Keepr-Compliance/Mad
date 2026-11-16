/**
 * Date formatting shared by the AI apps page and the Account page card
 * (BACKLOG-4238). UTC, so the server and the reader agree on the day.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export function formatDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return DATE_TIME_FORMAT.format(new Date(iso));
}
