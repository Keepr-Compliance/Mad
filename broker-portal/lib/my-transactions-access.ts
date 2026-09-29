/**
 * My Transactions access gate — BACKLOG-3080.
 *
 * One place decides what the My Transactions surfaces show the caller: the
 * sidebar entry (app/dashboard/layout.tsx), the list page and the detail page
 * all call getMyTransactionsGate(), so the link and the pages cannot disagree.
 *
 * Three answers:
 *
 *   admitted - a brokerage agent whose brokerage's plan has
 *              `portal_my_transactions` on. The pages read the agent's OWN
 *              submissions in THIS brokerage, through the session client.
 *   upsell   - the same brokerage agent, but the key is off, absent, or the
 *              feature read failed. The tab shows and the page explains the
 *              plan; NOTHING about any submission is read.
 *   null     - everyone else: impersonation, a full-portal user, the owner of
 *              a personal organization, an unknown or failed membership read,
 *              no membership. No tab; the pages call notFound().
 *
 * Order matters and is fixed: impersonation, then the shared portal classifier,
 * then floor via a BROKERAGE row, then the plan key on that brokerage.
 * The key is read FAIL-CLOSED (getOrgFeatures + isFeatureEnabledStrict: a
 * failed fetch has an empty feature map, which refuses) and only ever on the
 * brokerage organization the classifier chose, never on a personal one.
 *
 * BACKLOG-3593: `admitted` carries that one feature set, so the detail page
 * answers transaction_checklists from it in memory. One feature RPC per render.
 */

import { getImpersonationSession } from '@/lib/impersonation';
import { getPortalAccess, type PortalAccessResult } from '@/lib/auth/portalAccess';
import { getOrgFeatures, isFeatureEnabledFailClosed, isFeatureEnabledStrict, type OrgFeatures } from '@/lib/feature-gate';

/** feature_definitions.key seeded by the BACKLOG-3080 My Transactions migration. */
export const MY_TRANSACTIONS_FEATURE_KEY = 'portal_my_transactions';

export type MyTransactionsGate =
  | {
      kind: 'admitted';
      supabase: PortalAccessResult['supabase'];
      userId: string;
      organizationId: string;
      /** The brokerage's feature set, as fetched for the gate. Empty on a failed fetch. */
      features: OrgFeatures;
    }
  | { kind: 'upsell' }
  | null;

export async function getMyTransactionsGate(): Promise<MyTransactionsGate> {
  if (await getImpersonationSession()) return null;

  const portal = await getPortalAccess();
  if (!portal) return null;

  const { access } = portal;
  if (access.kind !== 'floor' || access.via !== 'brokerage') return null;

  const features = await getOrgFeatures(access.organizationId);
  if (!isFeatureEnabledStrict(features, MY_TRANSACTIONS_FEATURE_KEY)) return { kind: 'upsell' };

  return {
    kind: 'admitted',
    supabase: portal.supabase,
    userId: portal.user.id,
    organizationId: access.organizationId,
    features,
  };
}

/**
 * Does the agent page also apply the broker's message/attachment view keys
 * (broker_text_view, broker_email_view, broker_text_attachments,
 * broker_email_attachments)?
 *
 * `false` is the current default, pending the founder's confirmation: with
 * `portal_my_transactions` on, the agent sees their own messages and
 * attachments whatever those keys say. The broker's view entitlements are the
 * broker's, not the agent's. Flip it to `true` and agentChannelVisibility()
 * reads them FAIL-CLOSED — never through the broker page's fail-open helper.
 */
export const AGENT_VIEW_FOLLOWS_BROKER_VIEW_KEYS: boolean = false;

export interface AgentChannelVisibility {
  text: boolean;
  email: boolean;
  attachments: boolean;
}

/** Which message channels and whether attachments the agent page shows. */
export async function agentChannelVisibility(organizationId: string): Promise<AgentChannelVisibility> {
  if (!AGENT_VIEW_FOLLOWS_BROKER_VIEW_KEYS) return { text: true, email: true, attachments: true };
  const [text, email, textAttachments, emailAttachments] = await Promise.all([
    isFeatureEnabledFailClosed(organizationId, 'broker_text_view'),
    isFeatureEnabledFailClosed(organizationId, 'broker_email_view'),
    isFeatureEnabledFailClosed(organizationId, 'broker_text_attachments'),
    isFeatureEnabledFailClosed(organizationId, 'broker_email_attachments'),
  ]);
  return { text, email, attachments: textAttachments || emailAttachments };
}
