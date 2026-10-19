/**
 * App-level stacking bands (BACKLOG-3964). One place, so a new fixed layer is
 * placed against the others instead of guessed. Class strings are literals
 * here so Tailwind's content scan (src/**) still generates them.
 *
 *   popups / modals ........ z-50 .. z-[100]   (ResponsiveModal callers)
 *   Settings page layer .... z-[105]
 *   slice-3 account scrim .. z-[110]
 *   support "?" button ..... z-[115]   above Settings and the scrim
 *   support dialog ......... z-[118]   covers the "?" button and Settings; under toasts
 *   toasts ................. z-[120]   fired from inside Settings (General test notification)
 *   update notification .... z-[125]   keeps its place above toasts (same corner)
 */
export const Z_CLASS = {
  settings: "z-[105]",
  support: "z-[115]",
  supportDialog: "z-[118]",
  toast: "z-[120]",
  update: "z-[125]",
} as const;

/** Numeric value of a `z-[n]` / `z-n` class, or NaN. */
export function zValue(zClass: string): number {
  const m = /^z-(?:\[(\d+)\]|(\d+))$/.exec(zClass);
  return m ? Number(m[1] ?? m[2]) : NaN;
}
