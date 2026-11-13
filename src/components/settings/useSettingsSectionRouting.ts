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
 * ringed, and `onReached` (given the landed element) clears it, so asking for the same section again
 * fires again. A target rendered later than the sections themselves (an inner
 * element such as the texts look-back picker) is waited for with a
 * MutationObserver, never a timer; after GIVE_UP_MS without it the request is
 * dropped.
 *
 * BACKLOG-4174: sections above the landed one can still grow after landing
 * (device list, diagnostics, support-access snapshot), pushing it down. For
 * SECTION_SETTLE_MS after landing, a resize of the content column or the bottom
 * spacer scrolls the landed element back to the top, instantly and without a
 * second ring. Any user input ends that window; scroll events do not, because
 * the page's own scrolling fires them. The window outlives the target, which
 * the caller clears as soon as the section is reached.
 */
import { useEffect, useRef, type RefObject } from "react";
import { highlightSettingsTarget } from "@/utils/highlightSettingsTarget";

export const SECTION_ROUTING_GIVE_UP_MS = 5000;
export const SECTION_SETTLE_MS = 3000;
const USER_INPUT = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/** Keeps `el` at the top of `root` while the page settles; returns the stop function. */
function startSettle(root: HTMLElement, el: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  // Each element's height when the window opens; a report that differs is growth.
  // Seeded here, not from the first report: the spacer can reach its full
  // height in the same task as the landing, so its first report is already grown.
  const heights = new Map<Element, number>();
  const observer = new ResizeObserver((entries) => {
    let grew = false;
    for (const entry of entries) {
      const h = entry.contentRect.height;
      const before = heights.get(entry.target);
      heights.set(entry.target, h);
      if (before !== h) grew = true;
    }
    if (grew) el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" });
  });
  // The content column and the bottom spacer after it.
  for (const child of Array.from(root.children)) {
    heights.set(child, child.getBoundingClientRect().height);
    observer.observe(child);
  }
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const e of USER_INPUT) document.removeEventListener(e, stop, { capture: true });
  };
  const timer = setTimeout(stop, SECTION_SETTLE_MS);
  for (const e of USER_INPUT) document.addEventListener(e, stop, { capture: true, passive: true });
  return stop;
}

function findTarget(root: HTMLElement, target: string): HTMLElement | null {
  const byId = document.getElementById(target);
  if (byId && root.contains(byId)) return byId;
  return root.querySelector<HTMLElement>(`[data-testid="${target.replace(/["\\]/g, "\\$&")}"]`);
}

export function useSettingsSectionRouting(
  target: string | null | undefined,
  ready: boolean,
  containerRef: RefObject<HTMLElement | null>,
  /** Called with the element landed on, or with nothing when the target never appeared. */
  onReached?: (landed?: HTMLElement) => void,
): void {
  const stopSettleRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopSettleRef.current?.(), []);
  useEffect(() => {
    const root = containerRef.current;
    if (!ready || !target || !root) return;

    const land = (el: HTMLElement) => {
      highlightSettingsTarget(el);
      stopSettleRef.current?.();
      stopSettleRef.current = startSettle(root, el);
      onReached?.(el);
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
