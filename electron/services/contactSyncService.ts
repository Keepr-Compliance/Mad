/**
 * Contact Sync Service (TASK-2300)
 *
 * Shared contact sync orchestrator that abstracts provider-specific logic
 * (Outlook, Google, etc.) behind a common interface. Handles:
 * - Provider registration via dependency injection
 * - Preference-gated sync (checks isContactSourceEnabled)
 * - Delegation to externalContactDbService for storage
 * - Per-provider and all-provider sync orchestration
 *
 * Providers implement ContactSyncProvider to plug into this service.
 * The service does NOT own deduplication or UI-facing contact merging —
 * that remains in contactHandlers.ts where it reads from the shadow table.
 */

import logService from './logService';
import * as externalContactDb from './db/externalContactDbService';
import { isContactSourceEnabled } from '../utils/preferenceHelper';
import { isTokenExpiryError } from './emailSyncService';

// ============================================
// TYPES & INTERFACES
// ============================================

/**
 * A contact record ready for storage in the external_contacts shadow table.
 * Matches the shape expected by externalContactDbService upsert methods.
 */
export interface ExternalContactRecord {
  external_record_id: string;
  name: string | null;
  emails: string[];
  phones: string[];
  company: string | null;
}

/**
 * Result of a provider's canSync check.
 */
export interface CanSyncResult {
  ready: boolean;
  reconnectRequired?: boolean;
  error?: string;
}

/**
 * Interface that contact source providers must implement.
 *
 * Each provider (Outlook, Google, etc.) wraps its API-specific logic
 * and exposes a uniform interface for the sync orchestrator.
 */
export interface ContactSyncProvider {
  /** Unique source identifier (e.g., 'outlook', 'google') */
  readonly source: string;

  /** Preference key used with isContactSourceEnabled (e.g., 'outlookContacts') */
  readonly preferenceKey: string;

  /**
   * Check if this provider is ready to sync for the given user.
   * Should verify tokens, scopes, and any prerequisites.
   */
  canSync(userId: string): Promise<CanSyncResult>;

  /**
   * Fetch all contacts from the external source.
   * Returns contacts mapped to the common ExternalContactRecord format.
   */
  fetchContacts(userId: string): Promise<ExternalContactRecord[]>;
}

/**
 * Result of a sync operation for a single provider.
 */
export interface ProviderSyncResult {
  source: string;
  success: boolean;
  count: number;
  reconnectRequired?: boolean;
  /**
   * BACKLOG-2142: typed discriminator set when the provider failed because its
   * stored OAuth token is dead (expired/revoked). Classified via
   * isTokenExpiryError — NOT by parsing `error` text downstream. The renderer
   * orchestrator uses this to surface a provider-aware "Reconnect" CTA for the
   * contacts sync (mirrors the emails-path tokenExpired signal).
   */
  tokenExpired?: boolean;
  error?: string;
  syncResult?: externalContactDb.SyncResult;
}

// ============================================
// CONTACT SYNC SERVICE
// ============================================

/**
 * Orchestrates contact syncing across multiple providers.
 *
 * Usage:
 *   const service = new ContactSyncService();
 *   service.registerProvider(new OutlookContactProvider());
 *   service.registerProvider(new GoogleContactProvider());
 *   await service.syncAll(userId);
 */
export class ContactSyncService {
  private providers = new Map<string, ContactSyncProvider>();

  /**
   * Register a contact sync provider.
   * Providers are keyed by their `source` string.
   * Re-registering with the same source replaces the previous provider.
   */
  registerProvider(provider: ContactSyncProvider): void {
    this.providers.set(provider.source, provider);
    logService.info(
      `Registered contact sync provider: ${provider.source}`,
      'ContactSyncService',
    );
  }

  /**
   * Get a registered provider by source name.
   */
  getProvider(source: string): ContactSyncProvider | undefined {
    return this.providers.get(source);
  }

  /**
   * Get all registered provider source names.
   */
  getRegisteredSources(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Sync contacts from ALL registered providers for a user.
   *
   * - Checks user preferences for each provider (skips disabled ones)
   * - Calls canSync() to verify readiness
   * - Fetches and stores contacts via externalContactDbService
   * - Returns per-provider results
   *
   * Errors in one provider do NOT block others.
   */
  async syncAll(userId: string): Promise<ProviderSyncResult[]> {
    const results: ProviderSyncResult[] = [];

    for (const [source, provider] of this.providers) {
      try {
        const result = await this._syncSingleProvider(userId, provider);
        results.push(result);
      } catch (error) {
        // BACKLOG-2142: classify dead-token failures so the renderer can surface
        // a provider-aware reconnect CTA instead of a generic "Unexpected error".
        const tokenExpired = isTokenExpiryError(error);
        const reconnectRequired = this._extractReconnectRequired(error);
        logService.error(
          `Unexpected error syncing provider ${source}`,
          'ContactSyncService',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            tokenExpired,
          },
        );
        results.push({
          source,
          success: false,
          count: 0,
          tokenExpired,
          reconnectRequired,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  /**
   * Sync contacts from a specific provider by source name.
   *
   * Returns an error result if the source is not registered.
   */
  async syncProvider(userId: string, source: string): Promise<ProviderSyncResult> {
    const provider = this.providers.get(source);

    if (!provider) {
      logService.warn(
        `No provider registered for source: ${source}`,
        'ContactSyncService',
      );
      return {
        source,
        success: false,
        count: 0,
        error: `No provider registered for source: ${source}`,
      };
    }

    try {
      return await this._syncSingleProvider(userId, provider);
    } catch (error) {
      // BACKLOG-2142: classify dead-token failures (see syncAll).
      const tokenExpired = isTokenExpiryError(error);
      const reconnectRequired = this._extractReconnectRequired(error);
      logService.error(
        `Unexpected error syncing provider ${source}`,
        'ContactSyncService',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          tokenExpired,
        },
      );
      return {
        source,
        success: false,
        count: 0,
        tokenExpired,
        reconnectRequired,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * BACKLOG-2142: read the ad-hoc `reconnectRequired` flag that providers tack
   * onto thrown errors (e.g. Outlook/Google 403 scope errors) so it survives
   * the generic catch. Typed narrowing — no `any`.
   */
  private _extractReconnectRequired(error: unknown): boolean | undefined {
    const flag = (error as { reconnectRequired?: boolean } | null)?.reconnectRequired;
    return flag === true ? true : undefined;
  }

  /**
   * Internal: sync a single provider.
   *
   * 1. Check user preference (is this source enabled?)
   * 2. Call canSync() on the provider
   * 3. Fetch contacts
   * 4. Store via externalContactDbService.syncOutlookContacts (or equivalent)
   */
  private async _syncSingleProvider(
    userId: string,
    provider: ContactSyncProvider,
  ): Promise<ProviderSyncResult> {
    const { source, preferenceKey } = provider;

    // Step 1: Check if this source is enabled in user preferences
    const enabled = await isContactSourceEnabled(
      userId,
      'direct',
      preferenceKey,
      true,
    );

    if (!enabled) {
      logService.info(
        `Contact sync skipped for ${source} (disabled in preferences)`,
        'ContactSyncService',
        { userId },
      );
      return {
        source,
        success: true,
        count: 0,
      };
    }

    // Step 2: Check if provider is ready to sync
    const canSyncResult = await provider.canSync(userId);

    if (!canSyncResult.ready) {
      // BACKLOG-2142: a not-ready result whose error reads as a dead/expired
      // token (e.g. "Token refresh failed") is a reconnect case — classify it
      // so the renderer surfaces the reconnect CTA. Scope-missing 403s already
      // set reconnectRequired; token expiry is the additional signal.
      const tokenExpired = isTokenExpiryError(
        canSyncResult.error ? new Error(canSyncResult.error) : undefined,
      );
      logService.info(
        `Contact sync skipped for ${source}: not ready`,
        'ContactSyncService',
        { userId, error: canSyncResult.error, tokenExpired },
      );
      return {
        source,
        success: false,
        count: 0,
        reconnectRequired: canSyncResult.reconnectRequired,
        tokenExpired: tokenExpired || undefined,
        error: canSyncResult.error || `${source} provider is not ready to sync`,
      };
    }

    // Step 3: Fetch contacts from the provider
    logService.info(
      `Fetching contacts from ${source}`,
      'ContactSyncService',
      { userId },
    );

    const contacts = await provider.fetchContacts(userId);

    logService.info(
      `Fetched ${contacts.length} contacts from ${source}`,
      'ContactSyncService',
      { userId },
    );

    // Step 4: Store in external_contacts shadow table
    // Map ExternalContactRecord to ExternalContactInput (same shape)
    const dbContacts: externalContactDb.ExternalContactInput[] = contacts.map((c) => ({
      external_record_id: c.external_record_id,
      name: c.name,
      emails: c.emails,
      phones: c.phones,
      company: c.company,
    }));

    // TASK-2301: Use syncContactsBySource to route to correct source-specific sync
    // This ensures each provider's contacts are stored with the correct source value
    const syncResult = externalContactDb.syncContactsBySource(
      userId,
      source as externalContactDb.ExternalContactSource,
      dbContacts,
    );

    logService.info(
      `Contact sync complete for ${source}`,
      'ContactSyncService',
      {
        userId,
        inserted: syncResult.inserted,
        deleted: syncResult.deleted,
        total: syncResult.total,
      },
    );

    return {
      source,
      success: true,
      count: syncResult.inserted,
      syncResult,
    };
  }
}

// ============================================
// SINGLETON INSTANCE
// ============================================

/**
 * Default singleton instance of the contact sync service.
 * Providers are registered lazily via registerContactHandlers(),
 * not at module load time (TASK-2301 SR review fix).
 */
const contactSyncService = new ContactSyncService();

export default contactSyncService;
