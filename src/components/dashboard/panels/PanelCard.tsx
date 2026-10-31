/** The white card both Dashboard panels sit in (mock v6) — BACKLOG-3965 PR-4b. */
import React from "react";

export function PanelCard({
  title,
  aside,
  testId,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  testId: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      className="bg-white rounded-lg border border-gray-200 shadow-sm min-w-0 overflow-hidden"
      aria-label={title}
      data-testid={testId}
    >
      <div className="px-4 py-3 border-b border-gray-200 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function PanelMessage({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="px-4 py-6 text-sm text-gray-500 text-center">{children}</p>;
}
