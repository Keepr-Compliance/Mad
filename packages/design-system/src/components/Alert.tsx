import type { ReactNode } from 'react';
import { cn } from '../cn';

export type AlertVariant = 'error' | 'success' | 'warning' | 'info';

const VARIANT_CLASSES: Record<AlertVariant, { box: string; text: string }> = {
  error: { box: 'bg-red-50 border-red-200', text: 'text-red-700' },
  success: { box: 'bg-green-50 border-green-200', text: 'text-green-700' },
  warning: { box: 'bg-amber-50 border-amber-200', text: 'text-amber-800' },
  info: { box: 'bg-primary-50 border-primary-200', text: 'text-primary-800' },
};

export interface AlertProps {
  children: ReactNode;
  variant?: AlertVariant;
  /** Optional leading icon (sized by the caller, typically h-5 w-5). */
  icon?: ReactNode;
  className?: string;
}

/** Inline alert box (the portals have no toast system — errors render in place). */
export function Alert({ children, variant = 'error', icon, className }: AlertProps) {
  const classes = VARIANT_CLASSES[variant];
  return (
    <div className={cn('rounded-md border p-4', classes.box, className)} role={variant === 'error' ? 'alert' : undefined}>
      <div className="flex">
        {icon && <div className="flex-shrink-0">{icon}</div>}
        <div className={cn('text-sm', classes.text, icon ? 'ml-3' : undefined)}>{children}</div>
      </div>
    </div>
  );
}
