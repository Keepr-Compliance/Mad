/**
 * Learn mode rules as versioned data — BACKLOG-4120.
 *
 * Every rule and list the learn code adds lives here, under one version
 * number. Each answer row records `rule_version`, so answers given under one
 * set of rules can be told apart from answers given under the next.
 *
 * Baseline 0's own literals (the keyword lists and address pattern inside
 * `transactionExtractorService.analyzeEmail`) are NOT here. Changing them
 * changes the thing being measured, so a change to them bumps the version
 * (v3, BACKLOG-4225: the address string kept for each match; v4,
 * BACKLOG-4225: candidates that are sentences, not addresses, are dropped).
 *
 * Pure data. No imports, no I/O.
 */

/**
 * Bump when any rule below changes meaning, or when question generation
 * changes. v2 (BACKLOG-4175): cleanup questions leave out detections whose
 * every message is from an exact sender seed. v3 (BACKLOG-4225): which
 * emails get an address is unchanged, but the address kept for each one ends
 * at the address (a tail that crosses a line or has no real US state code is
 * cut at the street suffix), so detection titles and some keys change.
 * v4 (BACKLOG-4225 filter): a detected candidate that is a sentence, not an
 * address (too many name words, a sentence break in the name, or a weak
 * suffix such as "view" without a real city/state tail), is dropped. The
 * filter only removes: kept strings are unchanged and no email gets a new
 * first address, so every key existed under v3 and no stored answer is
 * asked again.
 */
export const LEARN_RULE_VERSION = 4;

export const LEARN_RULES = {
  version: LEARN_RULE_VERSION,

  /** Rows per keyset page when baseline 0 walks local mail. */
  scanPageSize: 200,

  /** Window bounds the run request may ask for, in months. */
  windowMonthsMin: 1,
  windowMonthsMax: 24,

  /** Messages drawn once for the bulk sample. */
  bulkSampleSize: 200,

  /** Bulk sample answers. One combined question (founder, 2026-11-04). */
  bulkAnswers: ["real_estate", "newsletter_spam", "skip"] as const,

  /** Cleanup pass answers. */
  dealAnswers: ["yes", "no"] as const,

  /**
   * Transaction type -> side. Only these map; "other" (and NULL) is not
   * scored and is counted as skipped.
   */
  sideByTransactionType: {
    purchase: "buyer",
    sale: "seller",
  } as Readonly<Record<string, "buyer" | "seller">>,

  /** analyzeEmail's transactionType -> side, for the detected side. */
  sideByDetectedType: {
    purchase: "buyer",
    sale: "seller",
  } as Readonly<Record<string, "buyer" | "seller">>,

  /** Transaction status -> outcome. "rejected" is a known negative, not an outcome. */
  outcomeByStatus: {
    closed: "closed",
    active: "active",
    pending: "pending",
  } as Readonly<Record<string, "closed" | "active" | "pending">>,
} as const;

export type BulkAnswer = (typeof LEARN_RULES.bulkAnswers)[number];
export type DealAnswer = (typeof LEARN_RULES.dealAnswers)[number];
