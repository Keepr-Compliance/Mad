import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

/**
 * Inline alert box (shadcn `Alert`, named `AlertBanner` here to avoid confusion
 * with the modal `AlertDialog`). The portals have no toast system — errors and
 * notices render in place.
 *
 * Variant colors use the Keepr token *scales* directly (primary/success/warning/
 * danger), matching @keepr/design-system's Alert exactly — zero drift, since
 * those scales come straight from tokens.json.
 *
 * Provide a leading icon as the first child; it is auto-positioned via `[&>svg]`.
 */
const alertVariants = cva(
  'relative w-full rounded-md border p-4 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:h-5 [&>svg]:w-5 [&>svg~*]:pl-7',
  {
    variants: {
      variant: {
        info: 'border-primary-200 bg-primary-50 text-primary-800 [&>svg]:text-primary-600',
        success:
          'border-success-200 bg-success-50 text-success-800 [&>svg]:text-success-600',
        warning:
          'border-warning-200 bg-warning-50 text-warning-800 [&>svg]:text-warning-600',
        destructive:
          'border-danger-200 bg-danger-50 text-danger-700 [&>svg]:text-danger-600',
      },
    },
    defaultVariants: {
      variant: 'info',
    },
  }
);

export type AlertBannerVariant = NonNullable<
  VariantProps<typeof alertVariants>['variant']
>;

export interface AlertBannerProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

export const AlertBanner = React.forwardRef<HTMLDivElement, AlertBannerProps>(
  ({ className, variant, ...props }, ref) => (
    <div
      ref={ref}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
);
AlertBanner.displayName = 'AlertBanner';

export const AlertBannerTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn('mb-1 font-medium leading-none tracking-tight', className)}
    {...props}
  />
));
AlertBannerTitle.displayName = 'AlertBannerTitle';

export const AlertBannerDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm [&_p]:leading-relaxed', className)} {...props} />
));
AlertBannerDescription.displayName = 'AlertBannerDescription';
