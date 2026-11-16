/**
 * What the Account page's AI apps card renders (BACKLOG-4238). Types only, so
 * the client card can import it without pulling in the server-only loader.
 */

export interface AiAppsCardApp {
  id: string;
  providerLabel: string;
  lastUsed: string;
}

export type AiAppsCardView =
  | { kind: 'ok'; apps: AiAppsCardApp[] }
  | { kind: 'failed' }
  | { kind: 'support' };
