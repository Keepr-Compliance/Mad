/**
 * Transaction Components Barrel Export
 * Re-exports all transaction-related components
 */

// TransactionStatusWrapper and related utilities
export {
  ManualEntryBadge,
  ConfidenceBar,
  getStatusConfig,
  default as TransactionStatusWrapper,
} from "./TransactionStatusWrapper";
export type {
  TransactionStatusType,
  StatusConfig,
  TransactionStatusWrapperProps,
} from "./TransactionStatusWrapper";

// TransactionCard
export { default as TransactionCard } from "./TransactionCard";
export type { TransactionCardProps } from "./TransactionCard";

// TransactionToolbar
export { default as TransactionToolbar } from "./TransactionToolbar";
export type { TransactionToolbarProps } from "./TransactionToolbar";

// DetectionBadges
export {
  DetectionSourceBadge,
  ConfidencePill,
  PendingReviewBadge,
} from "./DetectionBadges";

// NOTE: TransactionDetails has been moved to src/components/TransactionDetails.tsx
// and uses the transactionDetailsModule for tab components.
// Import it directly: import TransactionDetails from "./TransactionDetails";

// TransactionListCard
export { TransactionListCard } from "./TransactionListCard";
export type { TransactionListCardProps } from "./TransactionListCard";

// TransactionsToolbar
export { TransactionsToolbar } from "./TransactionsToolbar";
export type { TransactionsToolbarProps } from "./TransactionsToolbar";

// TransactionMobileCard (TASK-1440: mobile responsive card)
export { TransactionMobileCard } from "./TransactionMobileCard";
export type { TransactionMobileCardProps } from "./TransactionMobileCard";
