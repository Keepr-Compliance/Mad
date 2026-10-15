/**
 * BACKLOG-3156 stage E/G — the "Stored on this computer" cell treatment, shared
 * by Contacts and the three Messages source panes. Every cell wears the same
 * classes; a source switched off is dimmed (Contacts only). See the comment
 * above its import in MacOSContactsImportSettings.tsx for why one constant.
 */
export const STORED_CELL = {
  on: "p-2 rounded border bg-white border-gray-200",
  off: "p-2 rounded border bg-gray-50 border-gray-200 opacity-50",
  countOn: "text-lg font-semibold text-gray-900",
  countOff: "text-lg font-semibold text-gray-400",
  labelOn: "text-xs text-gray-500",
  labelOff: "text-xs text-gray-400",
} as const;
