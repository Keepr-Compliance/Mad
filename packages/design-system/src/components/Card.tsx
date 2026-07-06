import type { ReactNode } from 'react';
import { cn } from '../cn';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const PADDING_CLASSES: Record<CardPadding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-6',
  lg: 'p-8',
};

/** The canonical card surface, shared by every card-shaped primitive. */
export const cardSurfaceClasses = 'bg-white rounded-lg shadow-sm border border-gray-200';

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Adds hover elevation for clickable cards. */
  hover?: boolean;
  padding?: CardPadding;
}

/** Canonical content card: white surface, rounded-lg, subtle border + shadow. */
export function Card({ children, className, hover = false, padding = 'md' }: CardProps) {
  return (
    <div
      className={cn(
        cardSurfaceClasses,
        PADDING_CLASSES[padding],
        hover && 'hover:shadow-md hover:border-gray-300 transition-all',
        className
      )}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  children: ReactNode;
  className?: string;
  /** Optional right-aligned action area (buttons, toolbars). */
  action?: ReactNode;
}

export function CardHeader({ children, className, action }: CardHeaderProps) {
  return (
    <div className={cn('px-6 py-4 border-b border-gray-200 flex items-center justify-between', className)}>
      <div>{children}</div>
      {action && <div className="flex items-center gap-3">{action}</div>}
    </div>
  );
}

export function CardTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn('text-lg font-semibold text-gray-900', className)}>{children}</h3>;
}

export function CardDescription({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-sm text-gray-500', className)}>{children}</p>;
}

export function CardContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-6 py-4', className)}>{children}</div>;
}

export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-6 py-4 border-t border-gray-200', className)}>{children}</div>;
}
