/**
 * The Checklists sidebar entry's render policy — BACKLOG-3477 (ruling
 * 9af9ffbd on b152ee0a): a full-portal member of an organization whose plan
 * does not include checklists sees the entry GRAYED with one neutral line,
 * not hidden.
 *
 * - enabled  the route gate admits (isChecklistEditorEnabled, passed in by
 *            the layout so the entry and the route share one answer).
 * - grayed   the gate refuses, the caller is a full-portal user (broker,
 *            admin, it_admin of a brokerage: classifyPortalAccess 'full'),
 *            and feature_definitions.is_built is true for the feature.
 *            featureRenderPolicy is the portal's one rule for this
 *            (BACKLOG-3098).
 * - hidden   everything else: impersonation, floor users (agents), an
 *            unbuilt feature, an unreadable build state.
 *
 * Grayed is presentation only. The route, the actions and RLS still refuse.
 */

import { CHECKLIST_FEATURE_KEY } from '@/lib/checklist-access';
import {
  featureRenderPolicy,
  fetchFeatureBuildStates,
  isFeatureBuilt,
  type FeatureRenderPolicy,
} from '@/lib/feature-availability';

export async function getChecklistNavPolicy(options: {
  editorEnabled: boolean;
  isImpersonating: boolean;
  isFullPortalUser: boolean;
}): Promise<FeatureRenderPolicy> {
  if (options.isImpersonating) return 'hidden';
  if (options.editorEnabled) return 'enabled';
  if (!options.isFullPortalUser) return 'hidden';
  const built = await fetchFeatureBuildStates();
  return featureRenderPolicy(false, isFeatureBuilt(built, CHECKLIST_FEATURE_KEY));
}
