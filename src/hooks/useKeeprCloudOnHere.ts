/**
 * BACKLOG-4263 PR-6 (plan §14, Q7): whether Keepr Cloud is on for the signed-in user on this computer — the rule
 * main uses to keep a deleted deal for 30 days (`cloud_sync_settings.enabled = 1`). A local read in main, never
 * the network; offline counts the same as online. `null` until main answers; false when it cannot be reached.
 */
import { useEffect, useState } from "react";
import cloudSyncService from "@/services/cloudSyncService";

export function useKeeprCloudOnHere(): boolean | null {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void cloudSyncService.localState().then((s) => {
      if (live) setOn(s.on);
    });
    return () => {
      live = false;
    };
  }, []);
  return on;
}
