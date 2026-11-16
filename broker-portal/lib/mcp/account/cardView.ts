/**
 * The AI apps card on the Account page (BACKLOG-4238). Loaded on the server
 * through the same listMyConnections() the AI apps page uses; every string is
 * formatted here, so the client card only renders text.
 *
 * Never throws and never redirects: a list that cannot be read is 'failed',
 * and the rest of the Account page renders as before. A support session
 * (either signal) makes no database call and lists nothing, the same rule the
 * AI apps page applies.
 */

import { AI_APPS, PROVIDER_LABELS } from './messages';
import { formatDate } from './format';
import { listMyConnections } from './rpc';
import type { AiAppsCardView } from './cardTypes';

export async function loadAiAppsCard(impersonating: boolean): Promise<AiAppsCardView> {
  if (impersonating) return { kind: 'support' };
  try {
    const list = await listMyConnections();
    if (list.kind !== 'ok') return { kind: 'failed' };
    return {
      kind: 'ok',
      apps: list.connections.map((c) => ({
        id: c.id,
        providerLabel: PROVIDER_LABELS[c.provider],
        lastUsed: c.lastUsedAt === null ? AI_APPS.notUsed : AI_APPS.lastUsed(formatDate(c.lastUsedAt)),
      })),
    };
  } catch {
    return { kind: 'failed' };
  }
}
