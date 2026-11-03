/**
 * Room below the last Settings section (BACKLOG-3964, founder note on
 * 2.45.0-pre.3: "when I click About it doesn't scroll to the right section").
 *
 * Every Settings nav entry scrolls its section to the top of the page's
 * scroller (`scrollIntoView({ block: "start" })`). The last section (About)
 * is shorter than the scroller, so with nothing below it the scroll stopped at
 * the bottom with About low on the screen and Support Access / Troubleshooting
 * at the top. A trailing spacer of `scroller height - last section height`
 * gives the last section exactly enough room to reach the top; every earlier
 * section starts above it, so it can too.
 *
 * Re-measured when the page finishes loading, on window resize, and — where
 * ResizeObserver exists — when the scroller or the last section changes size.
 */
import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

export function useLastSectionSpacer(
  containerRef: RefObject<HTMLElement | null>,
  lastSectionId: string | undefined,
  enabled: boolean,
): number {
  const [height, setHeight] = useState(0);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const last = lastSectionId ? document.getElementById(lastSectionId) : null;
    if (!container || !last) return;
    setHeight(Math.max(0, container.clientHeight - last.offsetHeight));
  }, [containerRef, lastSectionId]);

  useLayoutEffect(() => {
    if (!enabled) return;
    measure();
    window.addEventListener("resize", measure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      const container = containerRef.current;
      const last = lastSectionId ? document.getElementById(lastSectionId) : null;
      if (container) observer.observe(container);
      if (last) observer.observe(last);
    }
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [enabled, measure, containerRef, lastSectionId]);

  return height;
}
