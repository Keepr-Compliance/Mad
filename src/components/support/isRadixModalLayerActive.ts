/**
 * Is a Radix modal layer open right now? (BACKLOG-4226)
 *
 * A Radix modal (the @keepr/ui Dialog used by Learn mode, AlertDialog, an
 * open Select) sets `pointer-events: none` inline on <body> while it is open,
 * and removes it when the last such layer closes:
 * @radix-ui/react-dismissable-layer, `disableOutsidePointerEvents`
 * (dist/index.mjs, the `ownerDocument.body.style.pointerEvents = "none"`
 * branch). Nothing in src/ sets that style itself.
 *
 * The support widget reads this once, when "?" is clicked and before the
 * screenshot, to decide whether the form must open in its own modal layer on
 * top (so it gets clicks and focus while the modal underneath pauses).
 *
 * This reads a Radix implementation detail. If a Radix upgrade moves the lock
 * elsewhere, the SupportWidget-4226 tests (real Learn dialogs) go red.
 */
export function isRadixModalLayerActive(doc: Document = document): boolean {
  return doc.body?.style.pointerEvents === "none";
}
