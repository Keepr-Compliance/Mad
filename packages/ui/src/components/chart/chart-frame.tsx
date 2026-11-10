import type { ReactNode } from 'react';

export interface ChartFrameProps {
  title: string;
  subtitle?: string;
  legend?: ReactNode;
  children: ReactNode;
}

/** The card a chart sits in: heading, subtitle, optional legend on the right. */
export function ChartFrame({ title, subtitle, legend, children }: ChartFrameProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          {subtitle ? <p className="text-xs text-gray-500">{subtitle}</p> : null}
        </div>
        {legend}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}
