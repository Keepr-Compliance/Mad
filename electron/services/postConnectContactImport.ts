/**
 * Post-Connect Contact Import (BACKLOG-1759)
 *
 * After a provider account connection is established (during onboarding OR
 * later via Settings), re-fire imports for contact sources that are
 * enabled-but-empty.
 *
 * The reported defect: a user selected "Outlook contacts" in the onboarding
 * contact-source step (persisting contactSources.direct.outlookContacts = true),
 * then connected their Microsoft mailbox. The Outlook contact import never
 * fired, so the user saw 0 Outlook contacts until they manually clicked
 * Settings -> Import (which worked instantly). macOS contacts imported without
 * OAuth, masking the failure.
 *
 * This helper is invoked fire-and-forget from the mailbox connection-completed
 * handlers. It triggers the SAME import path the manual Settings button uses
 * (contactSyncService.syncProvider -> external_contacts shadow table).
 *
 * Guarantees:
 * - Idempotent: skips a source that already has imported contacts (uses
 *   getContactSourceStats as the per-source signal — macOS contacts do NOT
 *   mask an empty Outlook/Google source because stats are keyed by source).
 * - Preference-gated: only fires for sources the user has enabled. Uses the
 *   same default (true) as contactSyncService.syncProvider and the manual
 *   sync path, so behavior is consistent with the existing import button.
 * - Never throws: each source is isolated in try/catch. This MUST NOT be able
 *   to fail the connect flow, so callers invoke it as `void ...().catch(...)`.
 *
 * @module services/postConnectContactImport
 */

import logService from './logService';
import * as externalContactDb from './db/externalContactDbService';
import type { ExternalContactSource } from './db/externalContactDbService';
import { isContactSourceEnabled } from '../utils/preferenceHelper';
import contactSyncService from './contactSyncService';

/**
 * Per-source outcome of a post-connect import attempt.
 */
export interface PostConnectImportResult {
  source: ExternalContactSource;
  /** Whether the source is enabled in user preferences */
  enabled: boolean;
  /** Whether the source already had imported contacts (skipped for idempotency) */
  alreadyImported: boolean;
  /** Number of contacts imported (0 if skipped) */
  imported: number;
  /** True if the provider needs a reconnect to grant contact scopes */
  reconnectRequired?: boolean;
  /** Error message if the import did not complete */
  error?: string;
}

/**
 * For each provider-backed source, trigger an import if the source is enabled
 * and currently has zero imported contacts.
 *
 * Never throws — safe to call fire-and-forget from a connection handler.
 *
 * @param userId - The user's UUID (must exist in the local DB)
 * @param sources - Provider-backed sources to consider (e.g. ['outlook'])
 * @returns Per-source results (for logging / renderer refresh decisions)
 */
export async function importEnabledEmptyContactSources(
  userId: string,
  sources: ExternalContactSource[],
): Promise<PostConnectImportResult[]> {
  const results: PostConnectImportResult[] = [];

  // Snapshot per-source counts once. This is the idempotency signal: a source
  // with > 0 contacts has already been imported and must not be re-synced.
  let stats: Record<string, number> = {};
  try {
    stats = externalContactDb.getContactSourceStats(userId);
  } catch (error) {
    // If we cannot read stats, fall back to treating everything as empty.
    // syncProvider is idempotent (full upsert) so a redundant sync is safe.
    logService.warn(
      '[PostConnectImport] Could not read contact source stats, proceeding as empty',
      'Contacts',
      { userId, error: error instanceof Error ? error.message : 'Unknown error' },
    );
    stats = {};
  }

  for (const source of sources) {
    const result: PostConnectImportResult = {
      source,
      enabled: false,
      alreadyImported: false,
      imported: 0,
    };

    try {
      const provider = contactSyncService.getProvider(source);
      if (!provider) {
        logService.warn(
          `[PostConnectImport] No provider registered for ${source}, skipping`,
          'Contacts',
          { userId },
        );
      } else {
        // Only fire for sources the user has enabled. Default true keeps this
        // consistent with syncProvider's internal gate and the manual button.
        const enabled = await isContactSourceEnabled(
          userId,
          'direct',
          provider.preferenceKey,
          true,
        );
        result.enabled = enabled;

        if (!enabled) {
          logService.info(
            `[PostConnectImport] ${source} not enabled — skipping post-connect import`,
            'Contacts',
            { userId },
          );
        } else if ((stats[source] ?? 0) > 0) {
          // Idempotent: contacts already imported for this source.
          result.alreadyImported = true;
          logService.info(
            `[PostConnectImport] ${source} already has ${stats[source]} imported contacts — skipping`,
            'Contacts',
            { userId },
          );
        } else {
          logService.info(
            `[PostConnectImport] Triggering post-connect import for ${source} (enabled, 0 contacts)`,
            'Contacts',
            { userId },
          );

          const syncResult = await contactSyncService.syncProvider(userId, source);
          result.imported = syncResult.count ?? 0;
          result.reconnectRequired = syncResult.reconnectRequired;
          result.error = syncResult.error;

          if (syncResult.success) {
            logService.info(
              `[PostConnectImport] ${source} post-connect import complete: ${result.imported} contacts`,
              'Contacts',
              { userId },
            );
          } else {
            logService.warn(
              `[PostConnectImport] ${source} post-connect import did not complete`,
              'Contacts',
              {
                userId,
                error: syncResult.error,
                reconnectRequired: syncResult.reconnectRequired,
              },
            );
          }
        }
      }
    } catch (error) {
      // Must never fail the connect flow — swallow and log.
      result.error = error instanceof Error ? error.message : 'Unknown error';
      logService.error(
        `[PostConnectImport] Unexpected error importing ${source} after connect`,
        'Contacts',
        { userId, error: result.error },
      );
    }

    results.push(result);
  }

  return results;
}
