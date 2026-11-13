/**
 * useVisibleSettingsTabs — BACKLOG-4174
 *
 * The Settings tab list for both surfaces that show it (the Settings page's
 * tab strip and the account side panel's rows), held until both reads that
 * decide it have settled:
 *
 *   - the plan read (`useFeatureGate`). `ai_detection` is not a strict key, so
 *     `isAllowed` answers true while the features map is still empty; showing
 *     the list then would show the AI tab and remove it a moment later.
 *     "Settled" is the same expression `FeatureGate` uses for its body:
 *     `!(loading && !hasInitialized)`. Both flags settle in `finally`, so a
 *     rejected read still settles (features stay empty → AI fail-open).
 *   - the strict `autodetect_eval` read (`useStrictFeatureState`), which is
 *     "pending" before its first answer and "unknown" if it fails.
 *
 * `tabs` is null until both have settled, then the visible list. The list is
 * never shown with an entry that a pending read would later remove.
 */

import { useMemo } from "react";
import { useFeatureGate } from "@/hooks/useFeatureGate";
import { useStrictFeatureState } from "@/hooks/useStrictFeatureState";
import { visibleSettingsTabs, type SettingsTab } from "./settingsTabs";

export interface VisibleSettingsTabs {
  /** null while either read is still pending. */
  tabs: SettingsTab[] | null;
  /** BACKLOG-4120: the strict autodetect_eval read is "allowed". */
  learnAvailable: boolean;
}

export function useVisibleSettingsTabs(): VisibleSettingsTabs {
  const { isAllowed, loading, hasInitialized } = useFeatureGate();
  const strictState = useStrictFeatureState("autodetect_eval");
  const planSettled = !(loading && !hasInitialized);
  const ready = planSettled && strictState !== "pending";
  const hasAIAddon = isAllowed("ai_detection");
  const learnAvailable = strictState === "allowed";

  const tabs = useMemo(
    () => (ready ? visibleSettingsTabs(hasAIAddon, learnAvailable) : null),
    [ready, hasAIAddon, learnAvailable],
  );
  return useMemo(() => ({ tabs, learnAvailable }), [tabs, learnAvailable]);
}
