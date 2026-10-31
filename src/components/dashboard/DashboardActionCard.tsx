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
}

/**
 * DashboardActionCard
 *
 * One white tile on kit tokens (Dashboard mock v6, BACKLOG-3965): gray border,
 * small shadow, primary icon chip, small semibold title. Every tile is the same
 * colour. No scale on hover (a transform would also add a stacking context).
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
}: DashboardActionCardProps): React.ReactElement {
  const isPrimary = variant === "primary";

  const className = [
    "w-full flex items-center gap-4 bg-white rounded-lg border shadow-sm text-left transition-colors",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500",
    isPrimary ? "p-5" : "p-3",
    highlighted ? "border-primary-500 ring-2 ring-primary-200" : "border-gray-200",
    // The gray hover border only on an unhighlighted tile: on a highlighted one
    // it would out-rank the primary border and turn it gray on hover.
    disabled
      ? "opacity-50 cursor-not-allowed"
      : `hover:shadow-md${highlighted ? "" : " hover:border-gray-300"}`,
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
        className={`shrink-0 rounded-lg bg-primary-50 text-primary-600 ${isPrimary ? "p-3" : "p-2"}`}
      >
        <div className="h-5 w-5">{icon}</div>
      </div>

      <div className="min-w-0 flex-1">
        <Heading
          className={`text-sm font-semibold text-gray-900${titleClassName ? ` ${titleClassName}` : ""}`}
        >
          {title}
        </Heading>
        {description && <p className="text-xs text-gray-500">{description}</p>}
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
