/**
 * The anchor around a checklist row's ⋮ toggle and its menu — BACKLOG-4263. Both row menus (My items and the
 * template rows' Keepr Cloud menu) wrap their toggle and menu in it.
 *
 * While `open`, the menu closes (`onClose`) when:
 * - a mouse button goes down outside the anchor (the kit's `useClickOutside`: `mousedown` on `document`);
 * - focus moves to an element outside the anchor (Tab out of the last entry, for one).
 *
 * Focus moving between the toggle and the entries stays inside the anchor, so the menu stays open. A blur with no
 * next element (the window losing focus, a click on the page or on the menu's padding) is left alone; the mouse
 * listener covers clicks. Closing never moves focus: an entry that opens something (Rename's input) keeps the focus it was given.
 */
import React, { useCallback, useEffect, useRef } from "react";
import { useClickOutside } from "@keepr/ui";

export function RowMenuAnchor({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const close = useCallback(() => onCloseRef.current(), []);
  useClickOutside(ref, close, open);
  return (
    <span
      ref={ref}
      className="relative"
      onBlur={(e) => {
        if (!open) return;
        const next = e.relatedTarget;
        // An element only: Chromium gives null when focus falls to the page, jsdom gives the document.
        if (next instanceof Element && !e.currentTarget.contains(next)) close();
      }}
    >
      {children}
    </span>
  );
}
