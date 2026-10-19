/**
 * Open the Settings page at a section (BACKLOG-3964).
 *
 * Replaces the 500 ms "scroll after the modal mounts" timer. That timer raced
 * the preferences load: Settings shows a spinner until they arrive, so a load
 * slower than the timer meant the section was not there yet and the user
 * landed at the top (measured in the SR plan review: 900 ms load -> 0 scrolls).
 *
 * Now the target is state (openSettings(target) stores it). Nothing happens
 * until `ready` (preferences loaded); then the target is scrolled to and
 * ringed, and `onReached` clears it, so asking for the same section again
 * fires again. A target rendered later than the sections themselves (an inner
 * element such as the texts look-back picker) is waited for with a
 * MutationObserver, never a timer; after GIVE_UP_MS without it the request is
 * dropped.
 */
import { useEffect, type RefObject } from "react";
import { highlightSettingsTarget } from "@/utils/highlightSettingsTarget";

export const SECTION_ROUTING_GIVE_UP_MS = 5000;

function findTarget(root: HTMLElement, target: string): HTMLElement | null {
  const byId = document.getElementById(target);
  if (byId && root.contains(byId)) return byId;
  return root.querySelector<HTMLElement>(`[data-testid="${target.replace(/["\\]/g, "\\$&")}"]`);
}

export function useSettingsSectionRouting(
  target: string | null | undefined,
  ready: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onReached?: () => void,
): void {
  useEffect(() => {
    const root = containerRef.current;
    if (!ready || !target || !root) return;

    const land = (el: HTMLElement) => {
      highlightSettingsTarget(el);
      onReached?.();
    };
    const found = findTarget(root, target);
    if (found) {
      land(found);
      return;
    }
    const observer = new MutationObserver(() => {
      const el = findTarget(root, target);
      if (!el) return;
      observer.disconnect();
      clearTimeout(giveUp);
      land(el);
    });
    observer.observe(root, { childList: true, subtree: true });
    const giveUp = setTimeout(() => {
      observer.disconnect();
      onReached?.();
    }, SECTION_ROUTING_GIVE_UP_MS);
    return () => {
      observer.disconnect();
      clearTimeout(giveUp);
    };
  }, [target, ready, containerRef, onReached]);
}
