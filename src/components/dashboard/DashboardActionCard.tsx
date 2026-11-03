/**
 * DashboardActionCard Component
 *
 * Reusable action card for dashboard buttons.
 * Provides consistent styling for primary and secondary actions.
 *
 * BACKLOG-294: Extract reusable component from Dashboard.tsx
 */

import React from "react";

export interface DashboardActionCardProps {
  /** Card title */
  title: string;
  /** Optional description text */
  description?: string;
  /** Click handler */
  onClick: () => void;
  /** Icon to display (an SVG that fills its box) */
  icon: React.ReactNode;
  /** Optional badge text (e.g., "3 new") */
  badge?: string | null;
  /** Whether the card is highlighted (e.g., has pending items) */
  highlighted?: boolean;
  /** Data attribute for tour targeting */
  dataTour?: string;
  /** data-testid on the button (e2e driver markers such as nav-transactions) */
  dataTestId?: string;
  /** Disables the card (e.g. while a sync runs) */
  disabled?: boolean;
  /** Extra classes for the title (e.g. whitespace-nowrap) */
  titleClassName?: string;
  /** Whether this is a primary (large) or secondary (smaller) card */
  variant?: "primary" | "secondary";
  /** Children to render after the title (e.g. a FeatureGate-wrapped badge) */
  children?: React.ReactNode;
  /**
   * Icon chip colour (BACKLOG-4110): "primary" = blue chip, "muted" = muted
   * ink on the warm fill. Default "muted"; only the lead tiles pass "primary".
   */
  chipTone?: "primary" | "muted";
}

const CHIP_TONE_CLASS = {
  primary: "bg-primary-50 text-primary-600",
  muted: "bg-warm-chip text-ink-muted",
} as const;

/**
 * DashboardActionCard
 *
 * One white tile (Dashboard mock v9, BACKLOG-4110): warm hairline, no resting
 * shadow, a blue chip on the lead tiles and a muted chip on the rest, ink
 * title. No scale on hover (a transform would also add a stacking context).
 */
export function DashboardActionCard({
  title,
  description,
  onClick,
  icon,
  badge,
  highlighted = false,
  dataTour,
  dataTestId,
  disabled = false,
  titleClassName,
  variant = "primary",
  children,
  chipTone = "muted",
}: DashboardActionCardProps): React.ReactElement {
  const isPrimary = variant === "primary";

  const className = [
    "w-full flex items-center gap-4 bg-white rounded-lg border text-left transition-colors",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
    isPrimary ? "px-5 py-3" : "p-3",
    highlighted ? "border-primary-500 ring-2 ring-primary-200" : "border-warm-line",
    // The warm hover border only on an unhighlighted tile: on a highlighted one
    // it would out-rank the primary border and turn it warm on hover.
    disabled
      ? "opacity-50 cursor-not-allowed"
      : `hover:shadow-md${highlighted ? "" : " hover:border-warm-control"}`,
  ].join(" ");

  const Heading = isPrimary ? "h2" : "h3";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={className}
      data-tour={dataTour}
      data-testid={dataTestId}
    >
      <div
        className={`shrink-0 rounded-lg ${CHIP_TONE_CLASS[chipTone]} ${isPrimary ? "p-3" : "p-2"}`}
        data-part="chip"
      >
        <div className="h-5 w-5">{icon}</div>
      </div>

      <div className="min-w-0 flex-1">
        <Heading
          className={`text-sm font-semibold text-ink${titleClassName ? ` ${titleClassName}` : ""}`}
        >
          {title}
        </Heading>
        {description && <p className="text-xs text-ink-muted">{description}</p>}
      </div>

      {badge && (
        <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-800 animate-pulse">
          {badge}
        </span>
      )}

      {children}
    </button>
  );
}

export default DashboardActionCard;
