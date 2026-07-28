/**
 * Application Constants
 * Centralized location for all magic numbers and strings
 */

// Date/Time Constants
export const MAC_EPOCH: number = new Date("2001-01-01T00:00:00Z").getTime();
export const FIVE_YEARS_IN_MS: number = 5 * 365 * 24 * 60 * 60 * 1000;

// Database Constants
export const MIN_CONTACT_RECORD_COUNT: number = 10;
export const CONTACTS_BASE_DIR: string =
  "Library/Application Support/AddressBook";
export const DEFAULT_CONTACTS_DB: string =
  "Library/Application Support/AddressBook/AddressBook-v22.abcddb";
export const MESSAGES_DB_PATH: string = "Library/Messages/chat.db";

// Message Text Parsing Constants
export const MAX_MESSAGE_TEXT_LENGTH: number = 10000;
export const MIN_MESSAGE_TEXT_LENGTH: number = 1;
export const MIN_CLEANED_TEXT_LENGTH: number = 2;
export const STREAMTYPED_MARKER: string = "streamtyped";
export const STREAMTYPED_OFFSET: number = 11; // Length of 'streamtyped'

// Regular Expressions
export const REGEX_PATTERNS: Record<string, RegExp> = {
  // Phone number normalization - remove all non-digit characters
  PHONE_NORMALIZE: /\D/g,

  // File name sanitization - allow only alphanumeric characters
  FILE_SANITIZE: /[^a-z0-9]/gi,

  // File name with spaces - allow alphanumeric and spaces
  FILE_SANITIZE_WITH_SPACES: /[^a-z0-9 ]/gi,

  // Message text extraction
  MESSAGE_TEXT_EXTRACT: /NSString.*?"((?:[^"\\]|\\.)*)"/g,
  MESSAGE_TEXT_READABLE: /[\x20-\x7E\u00A0-\uFFFF]{2,}/,
  MESSAGE_TEXT_ALPHANUMERIC: /[a-zA-Z0-9]/,

  // Control characters to remove
  NULL_BYTES: /\x00/g,
  CONTROL_CHARS: /[\x01-\x08\x0B-\x1F\x7F]/g,

  // Leading/trailing symbols
  LEADING_SYMBOLS: /^[^\w\s]+/,
  TRAILING_SYMBOLS: /[^\w\s]+$/,
};

// Fallback Messages
// BACKLOG-2262: The message parser (messageParser.ts) NO LONGER emits these on a
// decode miss — it returns "" (empty) so the importer can retain caption-less
// media (whose attachment would otherwise be orphaned) and legitimate messages
// that merely start with "[". These values are retained for legacy/display code
// and existing tests; they are no longer a "drop this row" signal at import.
export const FALLBACK_MESSAGES: Record<string, string> = {
  UNABLE_TO_EXTRACT: "[Message text - unable to extract from rich format]",
  PARSING_ERROR: "[Message text - parsing error]",
  ATTACHMENT: "[Attachment - Photo/Video/File]",
  REACTION_OR_SYSTEM: "[Reaction or system message]",
  UNABLE_TO_PARSE: "[Unable to parse message]", // TASK-1049: Deterministic fallback for unknown formats
};

// Window Configuration Interface
export interface WindowConfig {
  DEFAULT_WIDTH: number;
  DEFAULT_HEIGHT: number;
  TITLE_BAR_STYLE: string;
  BACKGROUND_COLOR: string;
}

// Application Window Configuration
export const WINDOW_CONFIG: WindowConfig = {
  DEFAULT_WIDTH: 1200,
  DEFAULT_HEIGHT: 800,
  TITLE_BAR_STYLE: "hiddenInset",
  BACKGROUND_COLOR: "#ffffff",
};

// Scan & Email Settings (TASK-2072: smart scan window + separate email cache):
//   1. Transaction Detection — automatic, uses last_sync_at per provider (no user setting)
//      First-ever scan looks back FIRST_SCAN_LOOKBACK_MONTHS (1 month)
//   2. emailCache.durationMonths (default 3) — how much email to cache locally
//   3. messageImport.filters.lookbackMonths (default 3) — how far back iMessage import looks
// Previously removed:
//   - scan.lookbackMonths (TASK-2072) — replaced with smart scan window (last_sync_at-based)
//   - DEFAULT_EMAIL_SYNC_LOOKBACK_MONTHS (TASK-2069) — first-time sync now uses FIRST_SCAN_LOOKBACK_MONTHS
//   - DEFAULT_LOOKBACK_MONTHS in autoLinkService (TASK-2068) — replaced with computeTransactionDateRange()

// TASK-2072: First-ever scan lookback (1 month for new users)
export const FIRST_SCAN_LOOKBACK_MONTHS: number = 1;

// TASK-2072: Default email cache duration (how much email to keep locally)
export const EMAIL_CACHE_DURATION_MONTHS_DEFAULT: number = 3;

// Development
export const DEV_SERVER_URL: string = "http://localhost:5173";
export const UPDATE_CHECK_DELAY: number = 5000; // 5 seconds after window loads
export const UPDATE_CHECK_INTERVAL: number = 4 * 60 * 60 * 1000; // 4 hours in ms (TASK-1970)
export const DOWNLOAD_STALL_TIMEOUT_MS: number = 60_000; // 60s — if no download-progress event fires within this window, report stall to Sentry (TASK-2330)
