import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Button variants.
 *
 * Names track the Keepr audit (primary/secondary/destructive/ghost) rather than
 * stock shadcn (default/secondary/…). Notably `secondary` renders the Keepr
 * "secondary button" recipe (white surface + border + hover:muted), which is
 * visually shadcn's `outline`; the stock shadcn gray-fill secondary is NOT used
 * so that wave-B adoption is a drop-in for @keepr/design-system's `secondary`.
 * `outline`/`link` are provided as bonus shadcn variants.
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'border border-input bg-background text-foreground hover:bg-muted',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-9 px-4 text-sm',
        lg: 'h-11 px-6 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the button styling onto the child element (Radix Slot). */
  asChild?: boolean;
  /** Show a leading spinner and disable the button while an action runs. */
  isLoading?: boolean;
}

/**
 * The canonical button. Radix `Slot` powers `asChild`; a11y (focus ring,
 * disabled semantics) is native to the `<button>` element.
 *
 * `isLoading` is ignored when `asChild` is set (Slot requires a single child).
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      isLoading = false,
      disabled,
      type,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        // Native buttons default to type="button" to avoid accidental form submits;
        // Slot forwards whatever the consumer's element expects.
        type={asChild ? type : (type ?? 'button')}
        disabled={asChild ? disabled : disabled || isLoading}
        aria-busy={isLoading || undefined}
        {...props}
      >
        {isLoading && !asChild ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  }
);
Button.displayName = 'Button';
