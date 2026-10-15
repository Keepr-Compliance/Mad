/**
 * Outlook Contact Provider (TASK-2300)
 *
 * Implements ContactSyncProvider to wrap existing outlookFetchService
 * contact-fetching logic. Maps OutlookContact[] to ExternalContactRecord[].
 *
 * This provider:
 * - Initializes the Outlook fetch service with user tokens
 * - Checks scope grants (Contacts.Read)
 * - Fetches contacts via Microsoft Graph API
 * - Maps to the common ExternalContactRecord format
 */

import outlookFetchService from '../outlookFetchService';
import logService from '../logService';
import type {
  ContactSyncProvider,
  CanSyncResult,
  ExternalContactRecord,
} from '../contactSyncService';

/**
 * Outlook contact sync provider.
 *
 * Wraps outlookFetchService.fetchContacts() and maps results
 * to the common ExternalContactRecord format.
 */
export class OutlookContactProvider implements ContactSyncProvider {
  readonly source = 'outlook';
  readonly preferenceKey = 'outlookContacts';

  /**
   * Check if Outlook contacts can be synced for this user.
   *
   * Verifies:
   * 1. OutlookFetchService can initialize (has valid OAuth tokens)
   * 2. Returns ready=true if initialization succeeds
   *
   * Note: Scope checking (Contacts.Read) happens inside fetchContacts(),
   * which returns reconnectRequired if scope is missing.
   */
  async canSync(userId: string): Promise<CanSyncResult> {
    try {
      const initialized = await outlookFetchService.initialize(userId);
      if (!initialized) {
        // BACKLOG-3879: `initialize()` returns false only when no Outlook
        // mailbox is connected. "Never connected" is not "reconnect me"
        // (BACKLOG-3203), so no `reconnectRequired` here.
        return {
          ready: false,
          error: 'No Outlook OAuth token found. User needs to connect Outlook first.',
        };
      }
      return { ready: true };
    } catch (error) {
      logService.warn(
        'Outlook canSync failed',
        'OutlookContactProvider',
        { userId, error: error instanceof Error ? error.message : 'Unknown error' },
      );
      return {
        ready: false,
        error: error instanceof Error ? error.message : 'Failed to initialize Outlook service',
      };
    }
  }

  /**
   * Fetch contacts from Outlook via Microsoft Graph API.
   *
   * Delegates to outlookFetchService.fetchContacts() which handles:
   * - Scope checking (Contacts.Read)
   * - Pagination (@odata.nextLink)
   * - 403 handling (reconnectRequired)
   * - Graph API contact mapping
   *
   * Maps OutlookContact[] to ExternalContactRecord[].
   */
  async fetchContacts(userId: string): Promise<ExternalContactRecord[]> {
    const fetchResult = await outlookFetchService.fetchContacts(userId);

    if (!fetchResult.success) {
      // If fetch failed due to scope/permission, throw with context
      const errorMessage = fetchResult.error || 'Failed to fetch Outlook contacts';

      if (fetchResult.reconnectRequired) {
        const error = new Error(errorMessage);
        (error as Error & { reconnectRequired?: boolean }).reconnectRequired = true;
        throw error;
      }

      throw new Error(errorMessage);
    }

    // Map OutlookContact to ExternalContactRecord
    // The shapes are identical — OutlookContact already matches ExternalContactRecord
    return fetchResult.contacts.map((contact) => ({
      external_record_id: contact.external_record_id,
      name: contact.name,
      emails: contact.emails,
      phones: contact.phones,
      company: contact.company,
    }));
  }
}
