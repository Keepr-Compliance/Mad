import type { ReactNode } from 'react';
import { cn } from '../cn';
import { cardSurfaceClasses } from './Card';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  /** lucide icon element; the standard treatment is `<Icon className="mx-auto h-12 w-12 text-gray-300" />`. */
  icon?: ReactNode;
  /** Optional call-to-action rendered under the description. */
  action?: ReactNode;
  /** Set false when rendering inside an existing card to skip the card chrome. */
  card?: boolean;
  className?: string;
}

export function EmptyState({ title, description, icon, action, card = true, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'text-center',
        card ? cn(cardSurfaceClasses, 'p-12') : 'py-12',
        className
      )}
    >
      {icon}
      <p className={cn('text-sm font-medium text-gray-900', icon ? 'mt-4' : undefined)}>{title}</p>
      {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
