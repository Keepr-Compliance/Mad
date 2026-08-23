/**
 * Transaction type display labels (main process / exports).
 *
 * BACKLOG-2805 (support ticket 112) — the founder-ruled strings: `purchase`
 * displays as **"Listing/Purchase"**, `sale` stays **"Sale"**.
 *
 * THE MIRROR OF `src/constants/transactionTypes.ts`. It exists because
 * `electron/` cannot import from `src/` (rootDir), and the three export
 * producers — folderExport/summaryHelpers, pdfExportService and
 * enhancedExportService — all print this field into a document the user
 * files. Keep the two files in step: each side's suite pins these exact
 * literals, so changing one alone turns the other red.
 *
 * DISPLAY ONLY. The keys are the stored enum values and must keep being used
 * for comparison, styling (`badge-${transaction_type}`) and persistence.
 */
export const TRANSACTION_TYPE_LABELS: Record<"purchase" | "sale", string> = {
  purchase: "Listing/Purchase",
  sale: "Sale",
};

/**
 * The label for a stored transaction type, or "N/A" when there is nothing to
 * name — an absent value, an empty string, or a valid-but-unlabelled member
 * such as `other`.
 *
 * Used by the text export, which previously printed the RAW LOWERCASE ENUM
 * ("Transaction Type: purchase") into a filed document. Callers that already
 * have their own fallback for `other` keep it and read the map directly, so
 * this change does not quietly alter what they render.
 */
export function getTransactionTypeLabel(type: string | undefined | null): string {
  if (!type) return "N/A";
  return TRANSACTION_TYPE_LABELS[type as "purchase" | "sale"] ?? "N/A";
}
