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
  /** Icon to display (SVG path) */
  icon: React.ReactNode;
  /** Gradient colors for icon background */
  iconGradient: string;
  /** Border/accent color class (e.g., "blue", "green", "purple") */
  accentColor: string;
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
  /** Children to render (e.g., wrapped in LicenseGate) */
  children?: React.ReactNode;
}

/**
 * DashboardActionCard
 *
 * Renders a styled action card with icon, title, optional badge, and arrow.
 * Supports primary (large) and secondary (smaller) variants.
 */
export function DashboardActionCard({
  title,
  description,
  onClick,
  icon,
  iconGradient,
  accentColor,
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

  // Base classes shared by both variants
  const baseClasses = [
    "group w-full bg-white rounded-2xl transition-all duration-300 text-left border-2 transform",
    isPrimary
      ? "shadow-xl p-6"
      : "relative bg-opacity-70 backdrop-blur shadow-lg p-6",
    disabled
      ? "opacity-50 cursor-not-allowed border-transparent"
      : [
          isPrimary ? "hover:shadow-2xl hover:scale-105" : "hover:shadow-xl hover:scale-[1.02]",
          highlighted
            ? `border-${accentColor}-500 ring-2 ring-${accentColor}-300 ring-offset-2 hover:border-${accentColor}-600`
            : `border-transparent hover:border-${accentColor}-${isPrimary ? "500" : "400"}`,
        ].join(" "),
  ].join(" ");
  const Heading = isPrimary ? "h2" : "h3";

  // Icon container size varies by variant
  const iconContainerSize = isPrimary ? "w-14 h-14" : "w-12 h-12";
  const iconSize = isPrimary ? "w-7 h-7" : "w-6 h-6";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={baseClasses}
      data-tour={dataTour}
      data-testid={dataTestId}
    >
      <div className="flex items-center gap-4">
        {/* Icon */}
        <div
          className={`${iconContainerSize} ${iconGradient} rounded-xl flex items-center justify-center shadow-lg group-hover:shadow-xl transition-all`}
        >
          <div className={`${iconSize} text-white`}>{icon}</div>
        </div>

        {/* Title and description */}
        <div className="flex-1">
          <Heading
            className={`font-bold text-gray-900 ${isPrimary ? "text-xl" : "text-lg mb-1"}${titleClassName ? ` ${titleClassName}` : ""}`}
          >
            {title}
          </Heading>
          {description && (
            <p className="text-sm text-gray-500">{description}</p>
          )}
        </div>

        {/* Badge (optional) */}
        {badge && (
          <span className="inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-sm font-semibold bg-indigo-100 text-indigo-800 animate-pulse">
            {badge}
          </span>
        )}

        {/* Additional children (e.g., LicenseGate-wrapped badge) */}
        {children}

        {/* Arrow */}
        <svg
          className={`w-5 h-5 text-${accentColor}-600 group-hover:translate-x-${isPrimary ? "1" : "2"} transition-transform`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
      </div>
    </button>
  );
}

export default DashboardActionCard;
