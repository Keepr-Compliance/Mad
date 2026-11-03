/**
 * Keep keyboard focus inside a layer while it is open, and give it back when
 * it closes (BACKLOG-3964 slice 3, the account panel).
 *
 * Call it from a component that stays mounted, with `active` true while the
 * layer shows. On every activation it:
 *   - records the element that had focus (the return target) — fresh on EVERY
 *     open, never once per mount;
 *   - focuses the first focusable element in the container;
 *   - makes Tab / Shift+Tab cycle inside the container (`deferTo` returning
 *     true leaves Tab alone, e.g. while the support form sits above the layer).
 * On deactivation it focuses the redirect target if one was set (see the
 * returned ref), else the recorded element, if it is still in the document.
 *
 * The container is read when a key is pressed, not when the trap starts, so a
 * container that remounts is never held stale.
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/** Set `.current` to a resolver to send focus somewhere else on the next close. */
export type FocusRedirect = MutableRefObject<(() => HTMLElement | null) | null>;

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  deferTo?: () => boolean,
): FocusRedirect {
  const returnTo = useRef<HTMLElement | null>(null);
  const redirect: FocusRedirect = useRef(null);
  const latestDefer = useRef(deferTo);
  latestDefer.current = deferTo;

  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement;
    returnTo.current = opener instanceof HTMLElement ? opener : null;
    redirect.current = null;
    const root = containerRef.current;
    if (root) focusables(root)[0]?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      if (latestDefer.current?.()) return;
      const container = containerRef.current;
      if (!container) return;
      const items = focusables(container);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!container.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const target = redirect.current?.() ?? returnTo.current;
      redirect.current = null;
      if (target && target.isConnected) target.focus();
    };
  }, [active, containerRef]);

  return redirect;
}
