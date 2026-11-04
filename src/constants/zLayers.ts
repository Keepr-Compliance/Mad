/**
 * App-level stacking bands (BACKLOG-3964). One place, so a new fixed layer is
 * placed against the others instead of guessed. Class strings are literals
 * here so Tailwind's content scan (src/**) still generates them.
 *
 *   popups / modals ........ z-50 .. z-[100]   (ResponsiveModal callers)
 *   Settings page layer .... z-[105]
 *   account panel scrim .... z-[110]   (shell/AccountPanel; never open with Settings)
 *   account side panel ..... z-[111]
 *   support "?" button ..... z-[115]   above Settings, the scrim and the panel
 *   support-access banner .. z-[106]   visible over Settings (z-[105]); under scrim and dialogs
 *   support dialog ......... z-[118]   covers the "?" button and Settings; under toasts
 *   toasts ................. z-[120]   fired from inside Settings (General test notification)
 *   update notification .... z-[125]   keeps its place above toasts (same corner)
 */
export const Z_CLASS = {
  settings: "z-[105]",
  supportAccess: "z-[106]",
  accountScrim: "z-[110]",
  accountPanel: "z-[111]",
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
