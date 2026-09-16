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
import type { StrictFeatureKey, StrictFeatureState } from "../types/featureGate";
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
 * What resolving the current user's organization found — BACKLOG-3349.
 *
 * `resolveOrgId` collapses all three failures into `null`, which is the right
 * answer for a fail-OPEN reader: it has nothing to say about them. A strict
 * reader has to tell them apart, because they produce different sentences:
 *
 *   - `no_session` / `error` → "we can't check your plan right now";
 *   - `none`                 → "not in your plan".
 *
 * `none` is a real answer. After BACKLOG-3364 every solo user has a personal
 * organization, so "no active membership" is an anomaly — a suspended or
 * retired member — and blocked is the correct reading of it.
 */
type OrgOutcome =
  | { status: "member"; organizationId: string }
  | { status: "no_session" }
  | { status: "none" }
  | { status: "error" };

/**
 * Resolve the current user's organization, keeping "none" and "error" apart.
 *
 * Deliberately does NOT catch. `getClient()` and `auth.getSession()` can throw,
 * and they throw out of `resolveOrgId` today; swallowing them here would change
 * the behaviour of three existing call sites while this item is supposed to
 * change exactly one key. The strict resolver catches for itself.
 */
async function resolveOrgOutcome(): Promise<OrgOutcome> {
  // Get session from the Supabase client (in-memory auth), NOT from session file
  const client = supabaseService.getClient();
  const { data: { session } } = await client.auth.getSession();

  if (!session?.user?.id) {
    logService.warn(
      "[FeatureGate] No active Supabase session, cannot resolve org",
      "FeatureGateHandlers"
    );
    return { status: "no_session" };
  }

  logService.debug(
    "[FeatureGate] Resolving org for user",
    "FeatureGateHandlers",
    { userId: session.user.id, email: session.user.email }
  );

  const outcome = await supabaseService.getActiveOrganizationMembershipOutcome(
    session.user.id
  );

  logService.debug(
    "[FeatureGate] Org resolution result",
    "FeatureGateHandlers",
    {
      orgId: outcome.status === "member" ? outcome.organization_id : "none",
      outcome: outcome.status,
    }
  );

  if (outcome.status === "member") {
    return { status: "member", organizationId: outcome.organization_id };
  }
  return { status: outcome.status };
}

/**
 * Resolve the organization ID for the current user.
 * Returns null if the user has no org membership.
 *
 * BACKLOG-2313: exported so the main-process auto-detect gate
 * (emailSyncHandlers.isAutoDetectAllowed) can resolve the org the same way.
 *
 * BACKLOG-3349: now a projection of {@link resolveOrgOutcome}. Unchanged for
 * every caller — the old membership getter already answered `null` for both a
 * failed lookup and no membership, so `null` here still means exactly what it
 * meant. BACKLOG-3364's `featureGateHandlers.personalOrg-3364` suite drives
 * this function through the real membership helper and is the regression guard
 * for that claim.
 */
export async function resolveOrgId(): Promise<string | null> {
  const outcome = await resolveOrgOutcome();
  return outcome.status === "member" ? outcome.organizationId : null;
}

// ---------------------------------------------------------------------------
// Strict (fail-closed) feature reads — BACKLOG-3349
// ---------------------------------------------------------------------------

/**
 * The main-process half of the strict key list.
 *
 * Typed `Record<StrictFeatureKey, true>`, so it cannot drift from the union in
 * `electron/types/featureGate.ts` or from the renderer's copy in
 * `src/hooks/useFeatureGate.ts` without failing `npm run type-check`.
 */
const STRICT_FEATURE_KEYS: Record<StrictFeatureKey, true> = {
  email_contact_inference: true,
};

/**
 * Is this a key that fails closed?
 *
 * `hasOwnProperty`, not `in` and not a truthiness test on the lookup: the key
 * arrives over IPC from the renderer, where anything can be sent. `"constructor"`
 * and `"__proto__"` are both truthy through the prototype chain, and either one
 * would otherwise be treated as a real feature and sent to the plan reader.
 */
export function isStrictFeatureKey(featureKey: unknown): featureKey is StrictFeatureKey {
  return (
    typeof featureKey === "string" &&
    Object.prototype.hasOwnProperty.call(STRICT_FEATURE_KEYS, featureKey)
  );
}

/**
 * Resolve one strict feature key to `allowed` / `blocked` / `unknown`.
 *
 * **`allowed` requires a POSITIVE read.** Everything else — no session, a
 * membership lookup that failed, a plan map that could not be fetched, a throw
 * from anywhere — is `unknown`, and `unknown` never grants. This is the
 * opposite of `featureGateService.checkFeature`, which returns allowed for an
 * unknown key and for no cache at all, and that difference is the whole reason
 * this function exists rather than reusing that one. Both behaviours are
 * correct for their own keys: an export must survive a flight with no wifi; a
 * commercial feature must not be granted by a failed network call.
 *
 * An EMPTY map is `unknown`, not `blocked`. `get_org_features` iterates every
 * `feature_definitions` row, so a successful read is never empty; a
 * `not_authorized` response, on the other hand, is stored as `{}` — and that
 * response says nothing whatsoever about the plan. Reading it as "not in your
 * plan" would put a false statement on screen.
 */
export async function resolveStrictFeatureState(
  featureKey: StrictFeatureKey
): Promise<StrictFeatureState> {
  try {
    const outcome = await resolveOrgOutcome();

    if (outcome.status === "no_session" || outcome.status === "error") {
      // Could not find out whose plan applies.
      return "unknown";
    }
    if (outcome.status === "none") {
      // A real answer: this user's plan grants nothing, because there is no
      // organization holding one.
      return "blocked";
    }

    const features = await featureGateService.getAllFeaturesOrNull(
      outcome.organizationId
    );
    if (!features) {
      return "unknown";
    }
    if (Object.keys(features).length === 0) {
      // A `not_authorized` response is cached as `{}`. Not an answer.
      return "unknown";
    }

    const feature = Object.prototype.hasOwnProperty.call(features, featureKey)
      ? features[featureKey]
      : undefined;
    if (!feature) {
      // The plan answered and does not carry this key — the state of every org
      // until the feature row is applied to the database.
      return "blocked";
    }
    return feature.allowed === true ? "allowed" : "blocked";
  } catch (error) {
    logService.warn(
      "[FeatureGate] Strict feature read failed, answering unknown",
      "FeatureGateHandlers",
      {
        featureKey,
        error: error instanceof Error ? error.message : "Unknown error",
      }
    );
    return "unknown";
  }
}

/**
 * The boolean form. **The only entry point a main-process consumer may use.**
 *
 * `blocked` and `unknown` both answer false. A consumer that acts on the
 * feature has nothing to do with the difference; a surface that EXPLAINS the
 * feature to a user does, and takes {@link resolveStrictFeatureState} instead.
 */
export async function isStrictFeatureAllowed(
  featureKey: StrictFeatureKey
): Promise<boolean> {
  return (await resolveStrictFeatureState(featureKey)) === "allowed";
}

/**
 * Which plan feature governs inferring contacts from which mailbox.
 *
 * **One key, named for what it gates rather than for a provider**, so that
 * BACKLOG-1717 can add Gmail with the single line `gmail:
 * "email_contact_inference"` — no migration, no second row for the founder to
 * switch on per customer, and no customer left looking at one live switch
 * beside one greyed switch that do the same kind of thing. Whether Gmail shares
 * the key is still the founder's to confirm; if he wants two, the second key is
 * a union member and a migration, and this map is where it goes.
 *
 * This map is the single place a provider becomes a plan key. Callers pass a
 * provider and never name a key literal.
 */
export const CONTACT_INFERENCE_FEATURE_KEYS = {
  outlook: "email_contact_inference",
  /**
   * BACKLOG-1717 — the second mailbox, on the SAME key.
   *
   * Founder, 2026-09-16, asked whether people found in Gmail are part of the
   * same paid feature as people found in Outlook: one shared feature. So this
   * is one line and nothing else — no migration, no second plan row to switch
   * on per customer, no second admin name, and one network read covering both
   * mailboxes instead of two.
   *
   * Per-mailbox control is not lost by sharing the key: it lives in the two
   * Settings switches, which already exist and which the user owns.
   *
   * Splitting this later costs exactly what adding a second key would have
   * cost now — one union member, one plan row, one line here. Collapsing two
   * keys that customers have already been provisioned against is the harder
   * direction, which is why one key is the reversible choice.
   */
  gmail: "email_contact_inference",
} as const satisfies Record<string, StrictFeatureKey>;

export type ContactInferenceProvider = keyof typeof CONTACT_INFERENCE_FEATURE_KEYS;

/** Three-state read for a surface that has to explain itself. */
export async function resolveContactInferenceState(
  provider: ContactInferenceProvider
): Promise<StrictFeatureState> {
  return resolveStrictFeatureState(CONTACT_INFERENCE_FEATURE_KEYS[provider]);
}

/**
 * The gate BACKLOG-1717 calls before building any email-inferred contact.
 *
 * Its contract there is `isContactInferenceAllowed(provider) &&
 * isContactSourceEnabled(userId, "inferred", ..., false)` — the plan and the
 * user's own switch, both required, evaluated in the IPC handler before the
 * read. Nothing is built here; this item only decides the first half.
 */
export async function isContactInferenceAllowed(
  provider: ContactInferenceProvider
): Promise<boolean> {
  return isStrictFeatureAllowed(CONTACT_INFERENCE_FEATURE_KEYS[provider]);
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

  // Strict (fail-closed) state for one key — BACKLOG-3349.
  //
  // One generic channel rather than one per feature: the renderer needs the
  // three-state answer for any strict key, and a channel per key would mean a
  // new channel, bridge method, bridge type and test default every time one is
  // added. Folding it into `feature-gate:get-all` was rejected — that payload
  // has 21 fail-open readers and changing its meaning would reach all of them.
  ipcMain.handle(
    "feature-gate:strict-state",
    async (
      _event: IpcMainInvokeEvent,
      featureKey: unknown
    ): Promise<StrictFeatureState> => {
      // The renderer can send anything. A key that is not on the strict list
      // gets "unknown" and never reaches the plan reader: answering for it
      // would be inventing a fail-closed reading of a fail-open key.
      if (!isStrictFeatureKey(featureKey)) {
        logService.warn(
          "[FeatureGate] Strict state requested for a key that is not strict",
          "FeatureGateHandlers",
          { featureKey: typeof featureKey === "string" ? featureKey : typeof featureKey }
        );
        return "unknown";
      }

      logService.debug(
        "[FeatureGate] Resolving strict feature state",
        "FeatureGateHandlers",
        { featureKey }
      );

      return resolveStrictFeatureState(featureKey);
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
