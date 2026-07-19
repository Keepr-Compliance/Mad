/**
 * Connection-status discriminators (BACKLOG-2127)
 *
 * A stored OAuth mailbox token can be in three meaningfully different states:
 *   - connected: the token works.
 *   - broken:    a token row EXISTS but is dead (refresh failed / expired /
 *                the connection check itself failed). The user must RECONNECT.
 *   - NOT_CONNECTED: no token row at all. This is the setup prompt's job, not
 *                    an error — the user simply hasn't connected email yet.
 *
 * `checkAllConnections` returns the typed `ConnectionErrorType` discriminator,
 * so consumers must key off `error.type` — never string-match a user-facing
 * message. These helpers centralize the "broken token" classification so the
 * sync path (useAutoRefresh), the setup-prompt gate, and any future consumer
 * agree by construction.
 *
 * @module utils/connectionStatus
 */

import type { ConnectionErrorType } from "../../electron/services/connectionStatusService";
import type { AllConnections, ProviderConnection } from "../services/systemService";

/**
 * Error types that mean "a token row exists but is dead → reconnect required".
 * Explicitly EXCLUDES NOT_CONNECTED (no token row = setup prompt, not an error).
 */
export const BROKEN_TOKEN_TYPES: ReadonlySet<ConnectionErrorType> = new Set<ConnectionErrorType>([
  "TOKEN_REFRESH_FAILED",
  "TOKEN_EXPIRED",
  "CONNECTION_CHECK_FAILED",
]);

/**
 * True when a provider connection's error indicates a broken (reconnect-able)
 * token, as opposed to a legitimately-absent connection.
 */
export function isBrokenTokenError(
  error: { type?: ConnectionErrorType } | null | undefined,
): boolean {
  return !!error?.type && BROKEN_TOKEN_TYPES.has(error.type);
}

/**
 * True when the provider should participate in email sync: it is either
 * connected OR has a broken token (which the user needs to be prompted to
 * reconnect). A pure NOT_CONNECTED provider returns false.
 */
export function providerNeedsEmailSync(
  provider: ProviderConnection | undefined,
): boolean {
  return !!provider && (provider.connected || isBrokenTokenError(provider.error));
}

/**
 * True when ANY provider in the connection snapshot has a broken token.
 * Used to suppress the "complete your setup" onboarding prompt for a user whose
 * mailbox is configured-but-broken — they should see a reconnect banner, not
 * onboarding copy.
 */
export function hasBrokenEmailToken(connections: AllConnections | undefined): boolean {
  if (!connections) return false;
  return [connections.google, connections.microsoft].some((p) => isBrokenTokenError(p?.error));
}
