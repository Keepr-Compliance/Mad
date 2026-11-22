/**
 * useVisibleSettingsTabs — BACKLOG-4174
 *
 * The Settings tab list for both surfaces that show it (the Settings page's
 * tab strip and the account side panel's rows), held until both reads that
 * decide it have settled:
 *
 *   - the plan read (`feature-gate:get-all`). `ai_detection` is not a strict
 *     key, so it reads allowed from an empty map; showing the list before the
 *     read settles would show the AI tab and remove it a moment later. `{}` is
 *     a settled answer; a rejected read is settled too ("failed" → AI
 *     fail-open, the rule in `isFeatureAllowed`).
 *   - the strict `autodetect_eval` read, "pending" before its first answer
 *     and "unknown" if it fails. Learn shows only on "allowed" (fail-closed).
 *
 * `tabs` is null until both have settled, then the visible list. The list is
 * never shown with an entry that a pending read would later remove.
 *
 * FIX A4: under a `StrictFeatureProvider` both answers come from the signed-in
 * session (`useSessionSettingsReads`), so a reopen shows its rows on the first
 * frame and corrects them one background IPC later. Outside a provider each
 * mount reads both once, as before.
 *
 * BACKLOG-4263: Keepr Cloud visibility is the third read, held the same way
 * (session slot under a provider, one `getView` per mount outside one). The
 * list stays null until it has settled too, so the Keepr Cloud row is never
 * inserted after the others.
 */

import { useEffect, useMemo, useState } from "react";
import type { StrictFeatureStateOrPending } from "../../../electron/types/featureGate";
import { useSessionSettingsReads, type SessionPlanFeatures } from "@/contexts/StrictFeatureContext";
import { isFeatureAllowed } from "@/hooks/featureAccess";
import cloudSyncService, { keeprCloudSectionVisible } from "@/services/cloudSyncService";
import { visibleSettingsTabs, type SettingsTab } from "./settingsTabs";

export interface VisibleSettingsTabs {
  /** null while either read is still pending. */
  tabs: SettingsTab[] | null;
  /** BACKLOG-4120: the strict autodetect_eval read is "allowed". */
  learnAvailable: boolean;
}

/**
 * @param options.reaskCloud false for Settings, which reads the full Keepr Cloud
 *   view itself and reports it (`useReportKeeprCloudView`); the account panel
 *   re-asks on every open.
 */
export function useVisibleSettingsTabs(options: { reaskCloud?: boolean } = {}): VisibleSettingsTabs {
  const session = useSessionSettingsReads({ reaskCloud: options.reaskCloud });
  const hasProvider = session !== null;
  const [localPlan, setLocalPlan] = useState<SessionPlanFeatures | null>(null);
  const [localLearn, setLocalLearn] = useState<StrictFeatureStateOrPending>("pending");
  const [localCloud, setLocalCloud] = useState<boolean | null>(null);

  // No provider: one plan read and one strict read per mount.
  useEffect(() => {
    if (hasProvider) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.api.featureGate.getAll();
        if (!cancelled) setLocalPlan(result && typeof result === "object" ? result : "failed");
      } catch {
        if (!cancelled) setLocalPlan("failed");
      }
    })();
    void (async () => {
      try {
        const result = await window.api.featureGate.strictState("autodetect_eval");
        if (!cancelled) setLocalLearn(result);
      } catch {
        if (!cancelled) setLocalLearn("unknown");
      }
    })();
    // getView never rejects: null (unreachable) reads hidden.
    void cloudSyncService.getView().then((view) => {
      if (!cancelled) setLocalCloud(keeprCloudSectionVisible(view));
    });
    return () => {
      cancelled = true;
    };
  }, [hasProvider]);

  const plan = session ? session.plan : localPlan;
  const learn = session ? session.learn : localLearn;
  const cloud = session ? session.cloud : localCloud;
  const ready = plan !== null && learn !== "pending" && cloud !== null;
  const cloudVisible = cloud === true;
  const hasAIAddon = isFeatureAllowed(plan === null || plan === "failed" ? {} : plan, "ai_detection");
  const learnAvailable = learn === "allowed";

  const tabs = useMemo(
    () => (ready ? visibleSettingsTabs(hasAIAddon, learnAvailable, cloudVisible) : null),
    [ready, hasAIAddon, learnAvailable, cloudVisible],
  );
  return useMemo(() => ({ tabs, learnAvailable }), [tabs, learnAvailable]);
}
