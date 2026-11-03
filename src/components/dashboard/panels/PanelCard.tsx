/** The white card both Dashboard panels sit in (mock v9: warm hairline + header strip, no shadow) — BACKLOG-3965 PR-4b, BACKLOG-4110. */
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
      className="bg-white rounded-lg border border-warm-line min-w-0 overflow-hidden"
      aria-label={title}
      data-testid={testId}
    >
      <div className="px-4 py-3 bg-warm-header border-b border-warm-line flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function PanelMessage({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="px-4 py-6 text-sm text-ink-muted text-center">{children}</p>;
}
