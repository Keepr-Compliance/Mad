import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import { buttonVariants } from './button';
import { cn } from '../lib/cn';

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Red confirm button + warning icon for irreversible actions. */
  isDestructive?: boolean;
  /** Disables both buttons and blocks dismissal while the action runs. */
  loading?: boolean;
}

/**
 * Confirm/cancel dialog built on Radix AlertDialog (full ARIA: `role="alertdialog"`,
 * focus trap, labelled title + description). Drop-in for @keepr/design-system's
 * `ConfirmationDialog` — same prop surface.
 *
 * When `isDestructive`, shows the red `AlertTriangle` treatment and a destructive
 * confirm button. When `loading`, both buttons disable and Escape/overlay
 * dismissal is blocked so the action can't be interrupted mid-flight.
 */
export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  isDestructive = false,
  loading = false,
}: ConfirmationDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Radix fires onOpenChange(false) on Escape/overlay/cancel. Route that
        // to onCancel, but never while an action is running.
        if (!next && !loading) onCancel();
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={(e) => {
          if (loading) e.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <div className="flex items-start gap-4">
            {isDestructive && (
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-danger-100">
                <AlertTriangle className="h-5 w-5 text-danger-600" aria-hidden="true" />
              </div>
            )}
            <div className="flex-1">
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription className="mt-2">
                {description}
              </AlertDialogDescription>
            </div>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={loading}
            onClick={(e) => {
              // preventDefault stops Radix's built-in close so the parent's
              // `open` stays the single source of truth — and onCancel isn't
              // double-fired (once from here, once from onOpenChange(false)).
              e.preventDefault();
              onCancel();
            }}
          >
            {cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={loading}
            onClick={(e) => {
              // Keep the dialog controlled by the parent's `open`; don't let the
              // default close race the async action.
              e.preventDefault();
              onConfirm();
            }}
            className={cn(
              isDestructive &&
                buttonVariants({ variant: 'destructive' })
            )}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
