/**
 * Esc closes the top layer, and only the top layer (BACKLOG-3964).
 *
 * The listener sits on `window` in the CAPTURE phase, so it runs before every
 * other Escape handler in the app: the document-level ones (InfoTooltip,
 * ConnectionMenu, GroupedMultiSelect), the window-level ones
 * (AttachmentPreviewModal) and React's own onKeyDown (NotSyncedChatsModal) —
 * and stopPropagation keeps the Escape from reaching a popup underneath. A
 * document listener or bubble-phase window listener would run after (or
 * alongside) those and close the popup underneath too.
 *
 * Attached only while `active`, so with the layer closed every popup gets its
 * Escape as before. `deferTo` lets a menu or dialog open INSIDE the layer take
 * the Escape for itself: when it returns true the event is left alone.
 */
import { useEffect, useRef } from "react";

export function useEscapeToClose(
  active: boolean,
  onEscape: () => void,
  deferTo?: () => boolean,
): void {
  const latest = useRef({ onEscape, deferTo });
  latest.current = { onEscape, deferTo };

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (latest.current.deferTo?.()) return;
      event.stopPropagation();
      event.preventDefault();
      latest.current.onEscape();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active]);
}
