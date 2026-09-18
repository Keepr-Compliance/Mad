/**
 * Google Contact Provider (TASK-2301)
 *
 * Implements ContactSyncProvider to fetch contacts from Google People API.
 * Maps Google Person resources to ExternalContactRecord format.
 *
 * This provider:
 * - Checks for Google OAuth token with contacts.readonly scope
 * - Fetches contacts via Google People API with pagination
 * - Maps GooglePerson to the common ExternalContactRecord format
 * - Handles 403 scope errors gracefully (reconnectRequired)
 * - Uses googleapis SDK for People API calls
 */

import { google, people_v1 } from 'googleapis';
import * as Sentry from '@sentry/electron/main';
import databaseService from '../databaseService';
import googleAuthService from '../googleAuthService';
import logService from '../logService';
import type {
  ContactSyncProvider,
  CanSyncResult,
  ExternalContactRecord,
} from '../contactSyncService';
import type { OAuthToken } from '../../types/models';

// ============================================
// CONSTANTS
// ============================================

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations';
const PAGE_SIZE = 1000;

// ============================================
// TYPES
// ============================================

/** A single person resource from Google People API */
type GooglePerson = people_v1.Schema$Person;

// ============================================
// PROVIDER
// ============================================

/**
 * Google contact sync provider.
 *
 * Fetches contacts from Google People API (connections endpoint)
 * and maps them to ExternalContactRecord format.
 */
export class GoogleContactProvider implements ContactSyncProvider {
  readonly source = 'google_contacts';
  readonly preferenceKey = 'googleContacts';

  /**
   * Check if Google contacts can be synced for this user.
   *
   * Verifies:
   * 1. Google OAuth token exists for the user
   * 2. Token has contacts.readonly scope granted
   * 3. Returns reconnectRequired if scope is missing
   */
  async canSync(userId: string): Promise<CanSyncResult> {
    try {
      const tokenRecord = await databaseService.getOAuthToken(
        userId,
        'google',
        'mailbox',
      );

      // BACKLOG-3203: NO `reconnectRequired` HERE — "never connected" is not
      // "reconnect me". The orchestrator surfaces `reconnectRequired` as a red
      // "Sync Completed with Errors" + a "Reconnect Gmail" CTA, and the Google
      // contacts source defaults ON (`googleContacts` is deliberately excluded
      // from BACKEND_DERIVED_DEFAULT_KEYS) with no connection-state gate on the
      // sync path. Flagging the no-token case therefore prompted every user who
      // has never connected a Google mailbox, on every sync, forever.
      //
      // `OutlookContactProvider` already behaves this way, BY ACCIDENT and not
      // by design: `outlookFetchService.initialize()` THROWS on a missing token
      // rather than returning false, so its `canSync` catch returns a bare
      // `{ ready: false, error }` and the `reconnectRequired: true` on its
      // `!initialized` path is unreachable. The accident is correct — do not
      // "fix" it into setting the flag.
      //
      // What remains flagged below is the state the flag is FOR: a mailbox that
      // IS connected but whose grant cannot read contacts.
      if (!tokenRecord || !tokenRecord.access_token) {
        return {
          ready: false,
          error: 'No Google OAuth token found. Please connect your Google mailbox first.',
        };
      }

      // Check if contacts.readonly scope is granted
      if (tokenRecord.scopes_granted) {
        const grantedScopes = typeof tokenRecord.scopes_granted === 'string'
          ? tokenRecord.scopes_granted
          : String(tokenRecord.scopes_granted);

        if (!grantedScopes.includes('contacts.readonly')) {
          logService.info(
            'contacts.readonly scope not granted. User needs to reconnect mailbox.',
            'GoogleContactProvider',
            { userId },
          );
          return {
            ready: false,
            reconnectRequired: true,
            error: 'Contacts permission not granted. Please disconnect and reconnect your Google mailbox to grant contact access.',
          };
        }
      }

      // Check if token is expired and try to refresh
      if (tokenRecord.token_expires_at) {
        const expiresAt = new Date(tokenRecord.token_expires_at);
        if (expiresAt <= new Date()) {
          logService.info(
            'Google token expired, attempting refresh',
            'GoogleContactProvider',
            { userId },
          );
          const refreshResult = await googleAuthService.refreshAccessToken(userId);
          if (!refreshResult.success) {
            return {
              ready: false,
              reconnectRequired: true,
              error: `Token refresh failed: ${refreshResult.error}`,
            };
          }
        }
      }

      return { ready: true };
    } catch (error) {
      logService.warn(
        'Google canSync failed',
        'GoogleContactProvider',
        { userId, error: error instanceof Error ? error.message : 'Unknown error' },
      );
      return {
        ready: false,
        error: error instanceof Error ? error.message : 'Failed to check Google sync readiness',
      };
    }
  }

  /**
   * Fetch contacts from Google People API.
   *
   * Uses the People API connections.list endpoint with pagination
   * via nextPageToken. Maps GooglePerson[] to ExternalContactRecord[].
   *
   * Handles:
   * - Pagination (nextPageToken)
   * - Token refresh on 401
   * - 403 scope errors (reconnectRequired)
   * - Empty/partial contact data
   */
  async fetchContacts(userId: string): Promise<ExternalContactRecord[]> {
    // Get fresh token from database
    const tokenRecord = await databaseService.getOAuthToken(
      userId,
      'google',
      'mailbox',
    );

    if (!tokenRecord || !tokenRecord.access_token) {
      throw new Error('No Google OAuth token available');
    }

    // Create OAuth2 client for People API calls
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );

    oauth2Client.setCredentials({
      access_token: tokenRecord.access_token,
      refresh_token: tokenRecord.refresh_token || undefined,
    });

    // Handle token refresh events
    oauth2Client.on('tokens', (tokens) => {
      void (async () => {
        logService.info('Google tokens refreshed during contacts fetch', 'GoogleContactProvider');
        if (tokens.access_token) {
          await databaseService.updateOAuthToken(tokenRecord.id, {
            access_token: tokens.access_token,
            token_expires_at: tokens.expiry_date
              ? new Date(tokens.expiry_date).toISOString()
              : undefined,
          });
        }
        if (tokens.refresh_token) {
          await databaseService.updateOAuthToken(tokenRecord.id, {
            refresh_token: tokens.refresh_token,
          });
        }
      })();
    });

    const peopleService = google.people({ version: 'v1', auth: oauth2Client });

    try {
      return await this._fetchAllContacts(peopleService);
    } catch (error) {
      return this._handleFetchError(error);
    }
  }

  /**
   * Fetch all contacts with pagination via nextPageToken.
   * @private
   */
  private async _fetchAllContacts(
    peopleService: people_v1.People,
  ): Promise<ExternalContactRecord[]> {
    const allContacts: ExternalContactRecord[] = [];
    let pageToken: string | undefined;
    let pageCount = 0;

    do {
      pageCount++;
      logService.debug(
        `Fetching Google contacts page ${pageCount}`,
        'GoogleContactProvider',
      );

      const response = await peopleService.people.connections.list({
        resourceName: 'people/me',
        personFields: PERSON_FIELDS,
        pageSize: PAGE_SIZE,
        pageToken,
      });

      const connections = response.data.connections || [];
      logService.debug(
        `Page ${pageCount}: Found ${connections.length} contacts`,
        'GoogleContactProvider',
      );

      for (const person of connections) {
        const mapped = this._mapPersonToContact(person);
        if (mapped) {
          allContacts.push(mapped);
        }
      }

      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);

    logService.info(
      `Total Google contacts fetched: ${allContacts.length}`,
      'GoogleContactProvider',
    );

    return allContacts;
  }

  /**
   * Handle fetch errors, converting 403 to reconnectRequired.
   * @private
   */
  private _handleFetchError(error: unknown): never {
    // Handle 403 Forbidden — token lacks contacts.readonly scope
    const gaxiosErr = error as { code?: number; response?: { status?: number } };
    const statusCode = gaxiosErr.code || gaxiosErr.response?.status;

    if (statusCode === 403) {
      logService.info(
        '403 Forbidden fetching Google contacts — token lacks contacts.readonly scope',
        'GoogleContactProvider',
      );
      const scopeError = new Error(
        'Access denied to Google contacts. Please disconnect and reconnect your Google mailbox to grant contact access.',
      );
      (scopeError as Error & { reconnectRequired?: boolean }).reconnectRequired = true;
      throw scopeError;
    }

    logService.error('Failed to fetch Google contacts', 'GoogleContactProvider', { error });
    Sentry.captureException(error, {
      tags: { service: 'google-contacts', operation: 'fetchContacts' },
    });
    throw error;
  }

  /**
   * Map a Google Person resource to ExternalContactRecord.
   *
   * Extracts:
   * - resourceName as external_record_id
   * - Primary or first name
   * - All email addresses
   * - All phone numbers
   * - Primary organization name as company
   *
   * Returns null if person has no resourceName (required for dedup).
   * @private
   */
  private _mapPersonToContact(person: GooglePerson): ExternalContactRecord | null {
    // resourceName is required for external_record_id
    if (!person.resourceName) {
      return null;
    }

    // Extract display name (prefer primary, fall back to first available)
    let name: string | null = null;
    if (person.names && person.names.length > 0) {
      const primaryName = person.names.find((n) => n.metadata?.primary) || person.names[0];
      name = primaryName.displayName || null;
    }

    // Extract all email addresses
    const emails: string[] = [];
    if (person.emailAddresses) {
      for (const emailEntry of person.emailAddresses) {
        if (emailEntry.value) {
          emails.push(emailEntry.value);
        }
      }
    }

    // Extract all phone numbers
    const phones: string[] = [];
    if (person.phoneNumbers) {
      for (const phoneEntry of person.phoneNumbers) {
        if (phoneEntry.value) {
          phones.push(phoneEntry.value);
        }
      }
    }

    // Extract company from organizations (primary or first)
    let company: string | null = null;
    if (person.organizations && person.organizations.length > 0) {
      const primaryOrg = person.organizations.find((o) => o.metadata?.primary) || person.organizations[0];
      company = primaryOrg.name || null;
    }

    return {
      external_record_id: person.resourceName,
      name,
      emails,
      phones,
      company,
    };
  }
}
