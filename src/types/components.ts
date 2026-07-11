/**
 * React Component Types for Keepr
 * These types are used throughout the React frontend
 */

import type { ReactNode } from "react";
import type {
  User,
  Contact,
  Transaction,
  Communication,
  ExportFormat,
  CommunicationType,
  OAuthProvider,
  ContactSource,
} from "../../electron/types/models";

// ============================================
// EXTENDED/SHARED TYPES
// ============================================

/**
 * Extended contact type with additional fields from Contacts app
 * Consolidates fields from various contact components
 */
export interface ExtendedContact extends Contact {
  /** All email addresses (from Contacts app import) */
  allEmails?: string[];
  /** All phone numbers (from Contacts app import) */
  allPhones?: string[];
  /** Count of property address mentions in communications */
  address_mention_count?: number;
  /** Last communication date with this contact */
  last_communication_at?: string | null;
  /** Whether this contact was derived from message participants (not explicitly imported) */
  is_message_derived?: number | boolean;
  /** Total communication count with this contact */
  communication_count?: number;
  /** Whether this contact exists in the database (false for external contacts from macOS Contacts) */
  isFromDatabase?: boolean;
}

/**
 * Transaction with roles field for blocking modal display
 * Used when showing which transactions a contact is involved in
 */
export interface TransactionWithRoles extends Transaction {
  /** Comma-separated list of roles the contact has in this transaction */
  roles?: string;
}

/**
 * Individual email entry for multi-email editing
 */
export interface ContactEmailEntry {
  id?: string;
  email: string;
  is_primary: boolean;
}

/**
 * Individual phone entry for multi-phone editing
 */
export interface ContactPhoneEntry {
  id?: string;
  phone: string;
  is_primary: boolean;
}

/**
 * Contact form data for add/edit operations
 */
export interface ContactFormData {
  name: string;
  email: string;
  phone: string;
  company: string;
  title: string;
  emails?: ContactEmailEntry[];
  phones?: ContactPhoneEntry[];
  defaultRole?: string;
}

/**
 * Source badge configuration
 */
export interface SourceBadge {
  text: string;
  color: string;
}

/**
 * Get source badge configuration for a contact source
 */
export function getSourceBadge(source: ContactSource): SourceBadge {
  const badges: Record<ContactSource, SourceBadge> = {
    manual: { text: "Manual", color: "bg-blue-100 text-blue-700" },
    email: { text: "From Email", color: "bg-green-100 text-green-700" },
    contacts_app: {
      text: "Contacts App",
      color: "bg-purple-100 text-purple-700",
    },
    sms: { text: "From SMS", color: "bg-orange-100 text-orange-700" },
    messages: { text: "From Messages", color: "bg-orange-100 text-orange-700" },
    inferred: { text: "Inferred", color: "bg-gray-100 text-gray-700" },
    outlook: { text: "Outlook", color: "bg-indigo-100 text-indigo-700" },
    google_contacts: { text: "Google Contacts", color: "bg-red-100 text-red-700" },
    android_sync: { text: "Android", color: "bg-emerald-100 text-emerald-700" },
    // BACKLOG-1900 (P0.1): required to keep Record<ContactSource> exhaustive.
    // P0.3 owns the richer SourcePill display treatment.
    iphone: { text: "iPhone", color: "bg-slate-100 text-slate-700" },
  };
  return badges[source] || badges.manual;
}

/**
 * Simple communication type for transaction details display
 * This is a subset of the full Communication/Message type for local use
 */
export interface TransactionCommunication {
  id: string;
  subject?: string;
  sender?: string;
  sent_at?: string;
  body_plain?: string;
}

// ============================================
// COMMON COMPONENT PROPS
// ============================================

export interface BaseComponentProps {
  className?: string;
  children?: ReactNode;
}

export interface LoadingProps {
  loading?: boolean;
  loadingText?: string;
}

export interface ErrorProps {
  error?: string | null;
  onErrorDismiss?: () => void;
}

// ============================================
// TRANSACTION COMPONENT PROPS
// ============================================

export interface TransactionListProps
  extends BaseComponentProps,
    LoadingProps,
    ErrorProps {
  transactions: Transaction[];
  selectedTransactionId?: string;
  onSelectTransaction?: (transaction: Transaction) => void;
  onDeleteTransaction?: (transactionId: string) => void;
  onExportTransaction?: (transactionId: string, format: ExportFormat) => void;
}

export interface TransactionDetailsProps
  extends BaseComponentProps,
    LoadingProps,
    ErrorProps {
  transaction: Transaction | null;
  contacts?: Contact[];
  communications?: Communication[];
  onUpdateTransaction?: (
    transactionId: string,
    updates: Partial<Transaction>,
  ) => void;
  onLinkContact?: (
    transactionId: string,
    contactId: string,
    role?: string,
  ) => void;
  onUnlinkContact?: (transactionId: string, contactId: string) => void;
  onExport?: (format: ExportFormat) => void;
}

export interface TransactionFormProps extends BaseComponentProps {
  transaction?: Transaction;
  userId: string;
  onSubmit: (transactionData: Partial<Transaction>) => void;
  onCancel?: () => void;
}

export interface TransactionCardProps extends BaseComponentProps {
  transaction: Transaction;
  selected?: boolean;
  onClick?: () => void;
  onDelete?: () => void;
  onExport?: (format: ExportFormat) => void;
}

// ============================================
// CONTACT COMPONENT PROPS
// ============================================

export interface ContactListProps
  extends BaseComponentProps,
    LoadingProps,
    ErrorProps {
  contacts: Contact[];
  selectedContactId?: string;
  onSelectContact?: (contact: Contact) => void;
  onDeleteContact?: (contactId: string) => void;
  onCreateContact?: () => void;
}

export interface ContactDetailsProps
  extends BaseComponentProps,
    LoadingProps,
    ErrorProps {
  contact: Contact | null;
  transactions?: Transaction[];
  onUpdateContact?: (contactId: string, updates: Partial<Contact>) => void;
  onDeleteContact?: (contactId: string) => void;
}

export interface ContactFormProps extends BaseComponentProps {
  contact?: Contact;
  userId: string;
  onSubmit: (contactData: Partial<Contact>) => void;
  onCancel?: () => void;
}

export interface ContactCardProps extends BaseComponentProps {
  contact: Contact;
  selected?: boolean;
  onClick?: () => void;
  showEmail?: boolean;
  showPhone?: boolean;
}

// ============================================
// COMMUNICATION COMPONENT PROPS
// ============================================

export interface ConversationListProps
  extends BaseComponentProps,
    LoadingProps,
    ErrorProps {
  communications: Communication[];
  selectedCommunicationId?: string;
  onSelectCommunication?: (communication: Communication) => void;
  filter?: {
    type?: CommunicationType;
    dateRange?: { start: Date; end: Date };
  };
}

export interface EmailViewProps extends BaseComponentProps {
  communication: Communication;
  onClose?: () => void;
}

export interface CommunicationFilterProps extends BaseComponentProps {
  onFilterChange: (filter: {
    type?: CommunicationType;
    dateRange?: { start: Date; end: Date };
    hasAttachments?: boolean;
  }) => void;
}

// ============================================
// DASHBOARD COMPONENT PROPS
// ============================================

export interface DashboardProps extends BaseComponentProps {
  user: User;
}

export interface DashboardStats {
  totalTransactions: number;
  activeTransactions: number;
  totalContacts: number;
  totalCommunications: number;
  recentActivity: Array<{
    type: "transaction" | "contact" | "communication";
    id: string;
    description: string;
    timestamp: string;
  }>;
}

export interface DashboardStatsProps extends BaseComponentProps {
  stats: DashboardStats;
  loading?: boolean;
}

// ============================================
// FORM COMPONENTS
// ============================================

export interface InputFieldProps {
  label: string;
  name: string;
  value: string | number;
  type?: "text" | "email" | "tel" | "number" | "date" | "password";
  placeholder?: string;
  required?: boolean;
  error?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  className?: string;
}

export interface SelectFieldProps<T = string> {
  label: string;
  name: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  placeholder?: string;
  required?: boolean;
  error?: string;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

export interface TextAreaFieldProps {
  label: string;
  name: string;
  value: string;
  placeholder?: string;
  required?: boolean;
  error?: string;
  rows?: number;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export interface DatePickerProps {
  label: string;
  value: Date | string | null;
  onChange: (date: Date | null) => void;
  minDate?: Date;
  maxDate?: Date;
  disabled?: boolean;
  className?: string;
}

// ============================================
// MODAL COMPONENTS
// ============================================

export interface ModalProps extends BaseComponentProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  size?: "small" | "medium" | "large" | "fullscreen";
  closeOnOverlayClick?: boolean;
}

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "default" | "danger" | "warning";
}

// ============================================
// BUTTON COMPONENTS
// ============================================

export interface ButtonProps extends BaseComponentProps {
  variant?: "primary" | "secondary" | "danger" | "success" | "ghost";
  size?: "small" | "medium" | "large";
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit" | "reset";
  onClick?: () => void;
  icon?: ReactNode;
}

// ============================================
// SETTINGS COMPONENT PROPS
// ============================================

export interface SettingsProps extends BaseComponentProps {
  user: User;
  onUpdateUser: (updates: Partial<User>) => void;
}

export interface ConnectionStatusProps {
  provider: OAuthProvider;
  connected: boolean;
  email?: string;
  onConnect: () => void;
  onDisconnect: () => void;
}

// ============================================
// EXPORT COMPONENT PROPS
// ============================================

export interface ExportOptionsProps {
  transactionId: string;
  onExport: (format: ExportFormat, options: ExportOptions) => void;
  onCancel?: () => void;
}

export interface ExportOptions {
  format: ExportFormat;
  includeAttachments: boolean;
  includeEmails: boolean;
  includeTexts: boolean;
  dateRange?: {
    start: Date;
    end: Date;
  };
}

export interface ExportProgressProps {
  progress: number;
  status: string;
  onCancel?: () => void;
}

// ============================================
// TOAST/NOTIFICATION TYPES
// ============================================

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastMessage {
  id: string;
  message: string;
  variant: ToastVariant;
  duration?: number;
}

export interface ToastProps extends BaseComponentProps {
  message: string;
  variant: ToastVariant;
  onClose: () => void;
  duration?: number;
}

// ============================================
// SIDEBAR/NAVIGATION TYPES
// ============================================

export interface SidebarProps extends BaseComponentProps {
  user: User;
  activePath: string;
  onNavigate: (path: string) => void;
}

export interface NavigationItem {
  path: string;
  label: string;
  icon?: ReactNode;
  badge?: number;
}

// ============================================
// TABLE TYPES
// ============================================

export interface TableColumn<T = unknown> {
  key: string;
  header: string;
  render?: (item: T) => ReactNode;
  sortable?: boolean;
  width?: string;
}

export interface TableProps<T = unknown> extends BaseComponentProps {
  columns: TableColumn<T>[];
  data: T[];
  keyExtractor: (item: T) => string;
  onRowClick?: (item: T) => void;
  selectedRowKey?: string;
  loading?: boolean;
  emptyMessage?: string;
}

// ============================================
// TOUR/ONBOARDING TYPES
// ============================================

export interface TourStep {
  target: string;
  title: string;
  content: string;
  placement?: "top" | "bottom" | "left" | "right";
  disableBeacon?: boolean;
}

export interface TourProps {
  steps: TourStep[];
  run: boolean;
  onComplete: () => void;
  onSkip?: () => void;
}
