import React from "react";
import type { ContactSource as ModelContactSource } from "../../../electron/types/models";

/**
 * Contact source types supported by the SourcePill component.
 * These map to visual variants for display.
 */
export type ContactSource =
  | "imported"
  | "external"
  | "manual"
  | "contacts_app"
  | "outlook"
  | "iphone"
  | "android_sync"
  | "google_contacts"
  | "sms"
  | "messages"
  | "email";

export interface SourcePillProps {
  /** The contact source - mapped to visual variant */
  source: ContactSource;
  /** Size of the pill */
  size?: "sm" | "md";
  /** Additional CSS classes */
  className?: string;
}

type Variant =
  | "contacts_app"
  | "message"
  | "manual"
  | "email"
  | "outlook"
  | "iphone"
  | "android"
  | "google";

const VARIANT_STYLES: Record<Variant, { bg: string; text: string; label: string }> = {
  manual: {
    bg: "bg-green-100",
    text: "text-green-700",
    label: "Manual",
  },
  contacts_app: {
    bg: "bg-violet-100",
    text: "text-violet-700",
    label: "Contacts App",
  },
  message: {
    bg: "bg-amber-100",
    text: "text-amber-700",
    label: "Message",
  },
  email: {
    bg: "bg-sky-100",
    text: "text-sky-700",
    label: "Email",
  },
  outlook: {
    bg: "bg-indigo-100",
    text: "text-indigo-700",
    label: "Outlook",
  },
  iphone: {
    bg: "bg-slate-100",
    text: "text-slate-700",
    label: "iPhone",
  },
  android: {
    bg: "bg-emerald-100",
    text: "text-emerald-700",
    label: "Android",
  },
  google: {
    bg: "bg-red-100",
    text: "text-red-700",
    label: "Google",
  },
};

const SIZE_STYLES: Record<"sm" | "md", string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-1 text-sm",
};

/**
 * Maps a contact source to its display variant (origin).
 * Import status is shown separately by ImportStatusPill.
 * - manual -> 'manual' (green)
 * - imported, contacts_app, external -> 'contacts_app' (violet)
 * - outlook -> 'outlook' (indigo)
 * - iphone -> 'iphone' (slate)
 * - android_sync -> 'android' (emerald)
 * - google_contacts -> 'google' (red)
 * - sms, messages -> 'message' (amber)
 * - email -> 'email' (sky)
 */
function getVariant(source: ContactSource): Variant {
  switch (source) {
    case "manual":
      return "manual";
    case "imported":
    case "contacts_app":
    case "external":
      return "contacts_app";
    case "outlook":
      return "outlook";
    case "iphone":
      return "iphone";
    case "android_sync":
      return "android";
    case "google_contacts":
      return "google";
    case "sms":
    case "messages":
      return "message";
    case "email":
      return "email";
    default:
      return "email";
  }
}

/**
 * SourcePill Component
 *
 * Displays a colored badge indicating the source of a contact.
 * Used across all contact management flows for consistent source visualization.
 *
 * @example
 * // Green "Imported" badge
 * <SourcePill source="contacts_app" />
 *
 * @example
 * // Blue "External" badge, medium size
 * <SourcePill source="external" size="md" />
 *
 * @example
 * // Gray "Message" badge
 * <SourcePill source="sms" />
 */
export function SourcePill({
  source,
  size = "sm",
  className = "",
}: SourcePillProps): React.ReactElement {
  const variant = getVariant(source);
  const styles = VARIANT_STYLES[variant];
  const sizeStyles = SIZE_STYLES[size];

  return (
    <span
      className={`inline-flex items-center font-medium rounded-full ${styles.bg} ${styles.text} ${sizeStyles} ${className}`.trim()}
      data-testid={`source-pill-${variant}`}
    >
      {styles.label}
    </span>
  );
}

/**
 * ImportStatusPill Component
 *
 * Small pill indicating whether a contact has been imported into Keepr.
 */
export function ImportStatusPill({
  isImported,
  size = "sm",
  className = "",
}: {
  isImported: boolean;
  size?: "sm" | "md";
  className?: string;
}): React.ReactElement {
  const sizeStyles = SIZE_STYLES[size];
  const styles = isImported
    ? { bg: "bg-green-100", text: "text-green-700", label: "Imported" }
    : { bg: "bg-gray-100", text: "text-gray-500", label: "Not Imported" };

  return (
    <span
      className={`inline-flex items-center font-medium rounded-full ${styles.bg} ${styles.text} ${sizeStyles} ${className}`.trim()}
      data-testid={`status-pill-${isImported ? "imported" : "not-imported"}`}
    >
      {styles.label}
    </span>
  );
}

/**
 * Maps model ContactSource to SourcePill's ContactSource.
 * Shared utility used by ContactRow, ContactPreview, ContactRoleRow, and ContactCard.
 */
export function mapToSourcePillSource(
  source: ModelContactSource | string | undefined,
  isExternal: boolean
): ContactSource {
  if (source === "sms" || source === "messages") return source;
  // Distinct provider/device origins keep their identity even when external
  // (not yet imported), so they never collapse into the generic "Contacts App"
  // or "Email" pills. (BACKLOG-1900 P0.3)
  if (source === "outlook") return "outlook";
  if (source === "iphone") return "iphone";
  if (source === "android_sync") return "android_sync";
  if (source === "google_contacts") return "google_contacts";
  if (isExternal || source === "contacts_app") return "contacts_app";
  switch (source) {
    case "manual":
      return "manual";
    case "email":
    case "inferred":
      return "email";
    default:
      return "email";
  }
}

export default SourcePill;
