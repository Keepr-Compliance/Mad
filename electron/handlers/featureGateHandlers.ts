// ============================================
// FEATURE GATE IPC HANDLERS
// SPRINT-122: Plan Admin + Feature Gate Enforcement
//
// Handles feature-gate IPC calls from the renderer.
// Resolves the current user's org from session before
// delegating to featureGateService.
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import supabaseService from "../services/supabaseService";
import featureGateService from "../services/featureGateService";
import type { FeatureAccess } from "../services/featureGateService";
import logService from "../services/logService";

/**
 * Features that require team/enterprise plans.
 * Individual users without an org are denied these features.
 * Used in both feature-gate:check and feature-gate:get-all handlers.
 */
const TEAM_ONLY_FEATURES = [
  "broker_submission",
  "ai_detection",
  "broker_email_view",
  "broker_email_attachments",
] as const;

/**
 * Resolve the organization ID for the current user.
 * Returns null if the user has no org membership.
 *
 * BACKLOG-2313: exported so the main-process auto-detect gate
 * (emailSyncHandlers.isAutoDetectAllowed) can resolve the org the same way.
 */
export async function resolveOrgId(): Promise<string | null> {
  // Get session from the Supabase client (in-memory auth), NOT from session file
  const client = supabaseService.getClient();
  const { data: { session } } = await client.auth.getSession();

  if (!session?.user?.id) {
    logService.warn(
      "[FeatureGate] No active Supabase session, cannot resolve org",
      "FeatureGateHandlers"
    );
    return null;
  }

  logService.debug(
    "[FeatureGate] Resolving org for user",
    "FeatureGateHandlers",
    { userId: session.user.id, email: session.user.email }
  );

  const membership = await supabaseService.getActiveOrganizationMembership(
    session.user.id
  );

  logService.debug(
    "[FeatureGate] Org resolution result",
    "FeatureGateHandlers",
    { orgId: membership?.organization_id ?? "none" }
  );

  return membership?.organization_id ?? null;
}

/**
 * Register all feature gate IPC handlers
 */
export function registerFeatureGateHandlers(): void {
  // Check a single feature
  ipcMain.handle(
    "feature-gate:check",
    async (
      _event: IpcMainInvokeEvent,
      featureKey: string
    ): Promise<FeatureAccess> => {
      logService.debug(
        "[FeatureGate] Checking feature",
        "FeatureGateHandlers",
        { featureKey }
      );

      const orgId = await resolveOrgId();
      if (!orgId) {
        // No org => individual user
        // Explicitly deny team/enterprise features
        if (TEAM_ONLY_FEATURES.includes(featureKey as typeof TEAM_ONLY_FEATURES[number])) {
          return { allowed: false, value: "", source: "default" };
        }
        // Individual features remain fail-open
        return { allowed: true, value: "", source: "default" };
      }

      return featureGateService.checkFeature(orgId, featureKey);
    }
  );

  // Get all features for the current org
  ipcMain.handle(
    "feature-gate:get-all",
    async (
      _event: IpcMainInvokeEvent
    ): Promise<Record<string, FeatureAccess>> => {
      logService.debug(
        "[FeatureGate] Getting all features",
        "FeatureGateHandlers"
      );

      const orgId = await resolveOrgId();
      if (!orgId) {
        // No org => individual user, restrict team/enterprise features
        // Individual features (text_export, email_export) remain fail-open
        // Team/Enterprise features are explicitly denied
        const denied: Record<string, FeatureAccess> = {};
        for (const key of TEAM_ONLY_FEATURES) {
          denied[key] = { allowed: false, value: "", source: "default" as const };
        }
        return denied;
      }

      return featureGateService.getAllFeatures(orgId);
    }
  );

  // Invalidate cache (force refresh on next check)
  ipcMain.handle(
    "feature-gate:invalidate-cache",
    async (_event: IpcMainInvokeEvent): Promise<void> => {
      logService.debug(
        "[FeatureGate] Invalidating cache",
        "FeatureGateHandlers"
      );
      featureGateService.invalidateCache();
    }
  );

  logService.debug(
    "Feature gate handlers registered",
    "FeatureGateHandlers"
  );
}
