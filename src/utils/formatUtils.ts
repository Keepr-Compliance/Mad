/**
 * Shared formatting utilities for the renderer.
 * Extracted from AttachmentCard, EmailViewModal, AttachmentPreviewModal, EmailThreadViewModal.
 * TASK-2029: Renderer-side utility deduplication.
 * TASK-C / BACKLOG-266: Consolidated formatDate and formatCurrency.
 */

// ============================================
// ERROR MESSAGE SAFETY
// ============================================

/**
 * Safely convert any value to a display-safe error string.
 * Prevents React error #310 ("Objects are not valid as a React child")
 * when IPC calls return error objects instead of strings.
 *
 * Common case: Supabase API returns { code: 500, error_code: "...", msg: "..." }
 * which, if rendered directly as JSX, crashes the component tree.
 *
 * @param value - Any value that might be an error string, object, or undefined
 * @param fallback - Fallback message when value is falsy. Defaults to "An error occurred".
 * @returns A plain string safe for JSX rendering
 */
export function safeErrorMessage(
  value: unknown,
  fallback = "An error occurred",
): string {
  if (!value) return fallback;
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Try common error object shapes (Supabase, IPC, etc.)
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.msg === "string") return obj.msg;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.error_message === "string") return obj.error_message;
    // Last resort: JSON stringify
    try {
      return JSON.stringify(value);
    } catch {
      return fallback;
    }
  }
  return String(value);
}

/**
 * Remove trailing ", USA" or ", US" from an address for cleaner display.
 */
export function formatAddress(address: string | null | undefined): string {
  if (!address) return "";
  return address.replace(/,\s*(USA|US)$/i, "");
}

/*
 */

/**
 * Format file size in human-readable format.
 * Handles null input for cases where file size is unknown.
 *
 * @param bytes - File size in bytes, or null if unknown
 * @returns Human-readable string like "1.2 MB", "0 B", or "" if null
 */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// ============================================
// DATE FORMATTING
// ============================================

interface FormatDateOptions {
  /** String to return when the input is null/undefined/invalid. Defaults to "N/A". */
  fallback?: string;
  /** Whether to include the year in the formatted output. Defaults to true. */
  includeYear?: boolean;
}

/**
 * Format a date string or Date object for display.
 * Consolidated from Transactions, TransactionList, StartNewAuditModal,
 * DeviceLimitScreen, AttachmentCard, AttachMessagesModal.
 *
 * @param dateString - A date string, Date object, or nullish value
 * @param options - Formatting options (fallback text, whether to include year)
 * @returns Formatted date string like "Jan 1, 2025" or the fallback value
 */
export function formatDate(
  dateString: string | Date | null | undefined,
  options?: FormatDateOptions,
): string {
  const { fallback = "N/A", includeYear = true } = options ?? {};

  if (!dateString) return fallback;

  try {
    const date =
      typeof dateString === "string" ? new Date(dateString) : dateString;

    // Guard against Invalid Date
    if (isNaN(date.getTime())) return fallback;

    const formatOptions: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      ...(includeYear && { year: "numeric" }),
    };

    return date.toLocaleDateString("en-US", formatOptions);
  } catch {
    return fallback;
  }
}

/**
 * BACKLOG-2109: format a transaction's last-export timestamp for at-a-glance
 * display ("Exported Jul 12"). Reads last_exported_on (the field the export
 * handlers actually write) and falls back to last_exported_at.
 *
 * @returns "Exported <Mon D>" when the tx has ever been exported, or null when
 *          it has never been exported (callers render nothing / "Never exported").
 */
export function formatLastExported(tx: {
  last_exported_on?: string;
  last_exported_at?: string;
}): string | null {
  const raw = tx.last_exported_on ?? tx.last_exported_at;
  if (!raw) return null;
  const formatted = formatDate(raw, { includeYear: false, fallback: "" });
  if (!formatted) return null; // invalid date ⇒ treat as never exported
  return `Exported ${formatted}`;
}

// ============================================
// CURRENCY FORMATTING
// ============================================

/**
 * Format a number as US currency (USD) with no decimal places.
 * Consolidated from Transactions, TransactionList, StartNewAuditModal.
 *
 * @param amount - The dollar amount, or null/undefined if unknown
 * @param fallback - String to return when the input is falsy. Defaults to "N/A".
 * @returns Formatted string like "$1,250" or the fallback value
 */
export function formatCurrency(
  amount: number | null | undefined,
  fallback: string = "N/A",
): string {
  if (amount === null || amount === undefined) return fallback;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(amount);
}
