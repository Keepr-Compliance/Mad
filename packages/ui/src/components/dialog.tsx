import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Modal dialog set (Radix Dialog). Radix supplies focus trap, scroll lock,
 * Escape/overlay dismissal, and `aria-modal`/labelling. Styling matches the
 * Keepr modal recipe: `bg-black/50` backdrop + white rounded-lg shadow-xl panel.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

/**
 * Marker for a control that must stay usable while a modal dialog is open
 * (BACKLOG-4226: the desktop app's floating support "?" button). A pointerdown
 * inside an element carrying this attribute is not treated as an outside
 * click, so it does not dismiss the dialog. The element must also set
 * `pointer-events: auto` itself, because a Radix modal sets
 * `pointer-events: none` on <body>.
 */
const MODAL_EXEMPT_ATTRIBUTE = 'data-modal-exempt';

type PointerDownOutsideHandler = NonNullable<
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>['onPointerDownOutside']
>;
type PointerDownOutsideEvent = Parameters<PointerDownOutsideHandler>[0];

/**
 * Runs the exemption first, then the caller's own handler (never replaced by
 * it, never replacing it). The caller sees `defaultPrevented` already set for
 * a pointerdown on an exempt control.
 */
function withModalExemption(
  handler: PointerDownOutsideHandler | undefined
): PointerDownOutsideHandler {
  return (event: PointerDownOutsideEvent) => {
    const target = event.target as Element | null;
    if (target && typeof target.closest === 'function' && target.closest(`[${MODAL_EXEMPT_ATTRIBUTE}]`)) {
      event.preventDefault();
    }
    handler?.(event);
  };
}

export const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/50', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Hide the default top-right close button. */
  hideClose?: boolean;
}

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, hideClose = false, onPointerDownOutside, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border bg-background p-6 shadow-xl',
        className
      )}
      {...props}
      onPointerDownOutside={withModalExemption(onPointerDownOutside)}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/**
 * A bare modal layer: portaled Radix Content with no overlay, no panel styling
 * and no transform (BACKLOG-4226). For content that draws its own surface but
 * must sit ON TOP of an open modal, taking its clicks and focus while the
 * modal underneath pauses. Carries the same exemption as DialogContent.
 * Use inside <Dialog>.
 */
export const DialogLayerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ onPointerDownOutside, ...props }, ref) => (
  <DialogPortal>
    <DialogPrimitive.Content
      ref={ref}
      {...props}
      onPointerDownOutside={withModalExemption(onPointerDownOutside)}
    />
  </DialogPortal>
));
DialogLayerContent.displayName = 'DialogLayerContent';

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col space-y-1.5 text-left', className)}
      {...props}
    />
  );
}
DialogHeader.displayName = 'DialogHeader';

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-col-reverse gap-3 sm:flex-row sm:justify-end',
        className
      )}
      {...props}
    />
  );
}
DialogFooter.displayName = 'DialogFooter';

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
