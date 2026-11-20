/**
 * A confirm for the Keepr Cloud section, rendered inline inside the Settings page with the shared
 * ResponsiveModal (the same mount as the confirms in EmailSettings and TroubleshootingSettings, z-[70]).
 *
 * Same props, markup, classes and button order as @keepr/ui's ConfirmationDialog, which it replaces here:
 * Cancel first, confirm second (red with the warning mark when destructive); `loading` disables both buttons.
 * Keyboard as before: Cancel has focus when it opens, so Enter cancels; Escape cancels unless an action runs;
 * a click on the backdrop does nothing; Tab stays inside; focus goes back where it was when it closes.
 */
import React, { useEffect, useId, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { buttonVariants } from "@keepr/ui";
import { ResponsiveModal } from "../../common/ResponsiveModal";
import { useEscapeToClose } from "../../../hooks/useEscapeToClose";

export interface SettingsConfirmProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDestructive?: boolean;
  loading?: boolean;
}

export function SettingsConfirm(props: SettingsConfirmProps): React.ReactElement | null {
  return props.open ? <OpenSettingsConfirm {...props} /> : null;
}

function OpenSettingsConfirm({
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  isDestructive = false,
  loading = false,
}: SettingsConfirmProps): React.ReactElement {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  // Runs after the Settings layer's own Escape listener, which leaves the key to an overlay open inside the page.
  useEscapeToClose(true, () => {
    if (!loading) onCancel();
  });

  const keepTabInside = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const buttons = Array.from(panelRef.current.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    if (buttons.length === 0) {
      e.preventDefault();
      return;
    }
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <ResponsiveModal zIndex="z-[70]" overlayClassName="bg-black bg-opacity-50" panelClassName="max-w-md p-6">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="grid gap-4"
        onKeyDown={keepTabInside}
      >
        <div className="flex flex-col space-y-2 text-left">
          <div className="flex items-start gap-4">
            {isDestructive && (
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-danger-100">
                <AlertTriangle className="h-5 w-5 text-danger-600" aria-hidden="true" />
              </div>
            )}
            <div className="flex-1">
              <h2 id={titleId} className="text-lg font-semibold text-foreground">
                {title}
              </h2>
              <p id={descriptionId} className="mt-2 text-sm text-muted-foreground">
                {description}
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            className={buttonVariants({ variant: "secondary" })}
            disabled={loading}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={buttonVariants({ variant: isDestructive ? "destructive" : "primary" })}
            disabled={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ResponsiveModal>
  );
}
