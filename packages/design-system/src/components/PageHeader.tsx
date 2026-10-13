import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned action area (primary buttons etc.). */
  actions?: ReactNode;
  className?: string;
  /**
   * Below md only: the title stays in the DOM as the h1 but is visually hidden
   * (the phone top bar shows the page title). Default false: no change.
   */
  phoneHideTitle?: boolean;
  /** Below md only: hide the subtitle line. Default false: no change. */
  phoneHideSubtitle?: boolean;
}

/** Standard page scaffold header: h1 + optional subtitle left, actions right, mb-6. */
export function PageHeader({ title, subtitle, actions, className, phoneHideTitle, phoneHideSubtitle }: PageHeaderProps) {
  // Nothing visible left on the left side below md and no actions: drop the gap too.
  const collapsesOnPhone = phoneHideTitle && (!subtitle || phoneHideSubtitle) && !actions;
  return (
    <div
      className={cn(
        'mb-6',
        actions ? 'flex items-center justify-between' : undefined,
        collapsesOnPhone && 'max-md:mb-0',
        className
      )}
    >
      <div>
        <h1 className={cn('text-2xl font-bold text-gray-900', phoneHideTitle && 'max-md:sr-only')}>{title}</h1>
        {subtitle && (
          <p className={cn('mt-1 text-sm text-gray-500', phoneHideSubtitle && 'max-md:hidden')}>{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
