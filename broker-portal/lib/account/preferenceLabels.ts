/**
 * The person's saved desktop settings, in the desktop's own words.
 * BACKLOG-3079.
 *
 * `user_preferences.preferences` is one nested jsonb blob per user. Nobody can
 * read it outside the desktop app — the admin portal touches the table in
 * exactly one place, a `phone_type` count for an analytics chart. The work in
 * this file IS the key -> label mapping; rendering the blob as JSON would be a
 * way of not doing it.
 *
 * ---------------------------------------------------------------------------
 * EVERY LABEL BELOW IS TRANSCRIBED FROM THE DESKTOP, NOT INVENTED.
 * ---------------------------------------------------------------------------
 * Two surfaces describing the same setting with different words is the drift
 * this cleanup is about, so each entry cites the renderer file it came from.
 * Onboarding uses different wording for several of the same keys ("Outlook /
 * Microsoft 365" vs "Outlook Contacts"); Settings is canonical here, because
 * Settings is the screen a person compares this page against.
 *
 * ---------------------------------------------------------------------------
 * ABSENT IS NOT null.
 * ---------------------------------------------------------------------------
 * In the desktop, an absent `messageImport.filters.lookbackMonths` means "Last
 * 3 months" and an absent `maxMessages` means "50,000" — only an EXPLICIT null
 * means "All time" / "Unlimited" (src/components/settings/
 * messageImportPreferences.ts, DEFAULT_LOOKBACK_MONTHS / DEFAULT_MAX_MESSAGES;
 * getting this wrong was a real bug twice, BACKLOG-2749 / 2795).
 *
 * This page sidesteps that entirely by showing ONLY what is stored: an absent
 * key produces no row at all, so no default is ever restated here and it cannot
 * drift from the desktop's. An explicit null does produce a row, and formats as
 * "All time" / "Unlimited".
 */

/** A stored setting, resolved for display. */
export interface ResolvedPreference {
  /** Dotted path into the blob, e.g. "contactSources.direct.iphoneContacts". */
  path: string;
  /** Section heading, mirroring the desktop's Settings tabs. */
  group: string;
  /** The desktop's own label for this control. */
  label: string;
  /** The stored value, formatted the way the desktop renders it. */
  display: string;
  /** False when no label is recorded for this path — see UNMAPPED_GROUP. */
  mapped: boolean;
}

/** Where a key with no recorded label goes. Never dropped, never raw JSON. */
export const UNMAPPED_GROUP = 'Other settings';

/** Section order, mirroring the desktop's Settings tab strip. */
export const GROUP_ORDER = [
  'General',
  'Email Connections',
  'Messages',
  'iPhone Sync',
  'Contacts',
  'Setup',
  UNMAPPED_GROUP,
] as const;

type Formatter = (value: unknown) => string;

interface PreferenceEntry {
  group: string;
  label: string;
  format?: Formatter;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const onOff: Formatter = (v) => (v === true ? 'On' : v === false ? 'Off' : formatScalar(v));

/** Build a formatter from one of the desktop's option lists. */
function options(map: Record<string, string>): Formatter {
  return (v) => map[String(v)] ?? formatScalar(v);
}

/** src/components/settings/MacOSMessagesImportSettings.tsx / AndroidMessagesSettings.tsx */
const lookbackMonths: Formatter = (v) =>
  v === null ? 'All time' : typeof v === 'number' ? `Last ${v} months` : formatScalar(v);

const maxMessages: Formatter = (v) =>
  v === null
    ? 'Unlimited'
    : typeof v === 'number'
      ? v.toLocaleString('en-US')
      : formatScalar(v);

/** src/components/settings/EmailSettings.tsx — 1/3/6/12 with "1 year" for 12. */
const cacheMonths: Formatter = (v) =>
  v === 12 ? '1 year' : typeof v === 'number' ? `${v} month${v === 1 ? '' : 's'}` : formatScalar(v);

/** Anything with no better rendering. Never leaks an object at the reader. */
export function formatScalar(value: unknown): string {
  if (value === null) return 'Not set';
  if (value === undefined) return 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value === '' ? 'Not set' : value;
  if (Array.isArray(value)) {
    return value.length === 0 ? 'None' : value.map(formatScalar).join(', ');
  }
  // A leaf that is still an object means the blob grew a shape this page has
  // not seen. Say so; do not print JSON at a reader who cannot act on it.
  return 'Saved (not shown here)';
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export const PREFERENCE_LABELS: Readonly<Record<string, PreferenceEntry>> = {
  // --- General (src/components/settings/GeneralSettings.tsx) ---------------
  'sync.autoSyncOnLogin': { group: 'General', label: 'Auto-Sync on Startup', format: onOff },
  'updates.autoDownload': { group: 'General', label: 'Auto-download Updates', format: onOff },
  'contactAutoRole.enabled': { group: 'General', label: 'Auto-fill Contact Roles', format: onOff },
  'export.defaultFormat': {
    group: 'General',
    label: 'Export format',
    format: options({
      'combined-pdf': 'One PDF',
      folder: 'Audit Package',
      pdf: 'Summary PDF',
    }),
  },
  'export.contentType': {
    group: 'General',
    label: 'Export content',
    format: options({ both: 'Both', emails: 'Emails Only', texts: 'Texts Only' }),
  },
  'export.attachmentType': {
    group: 'General',
    label: 'Export attachments',
    format: options({ all: 'All', email: 'Email Only', text: 'Text Only', none: 'None' }),
  },
  'export.emailExportMode': {
    group: 'General',
    label: 'Export email mode',
    format: options({ thread: 'Thread View', individual: 'Individual' }),
  },

  // --- Email (src/components/settings/EmailSettings.tsx) -------------------
  'emailCache.durationMonths': {
    group: 'Email Connections',
    label: 'Email History',
    format: cacheMonths,
  },
  // No control renders this. It is a read-only fallback the desktop consults
  // when emailCache.durationMonths is absent, and the renderer never writes it.
  'emailSync.lookbackMonths': {
    group: 'Email Connections',
    label: 'Email History (older setting)',
    format: cacheMonths,
  },

  // --- Messages ------------------------------------------------------------
  'messages.source': {
    group: 'Messages',
    label: 'Import Source',
    format: options({
      'macos-native': 'macOS Messages',
      'iphone-sync': 'iPhone Sync',
      'android-companion': 'Android Companion',
    }),
  },
  'messageImport.filters.lookbackMonths': {
    group: 'Messages',
    label: 'macOS Messages — import messages from',
    format: lookbackMonths,
  },
  'messageImport.filters.maxMessages': {
    group: 'Messages',
    label: 'macOS Messages — maximum messages',
    format: maxMessages,
  },
  'messageImport.filters.skipAttachments': {
    group: 'Messages',
    label: 'macOS Messages — import message text only',
    format: onOff,
  },
  'messageImport.android.filters.lookbackMonths': {
    group: 'Messages',
    label: 'Android Companion — import messages from',
    format: lookbackMonths,
  },
  'messageImport.android.filters.maxMessages': {
    group: 'Messages',
    label: 'Android Companion — maximum messages',
    format: maxMessages,
  },

  // --- iPhone Sync ---------------------------------------------------------
  'integrations.iphoneSyncEnabled': {
    group: 'iPhone Sync',
    label: 'iPhone Sync (USB)',
    format: onOff,
  },

  // --- Contacts (src/components/settings/MacOSContactsImportSettings.tsx) ---
  'contactSources.direct.macosContacts': { group: 'Contacts', label: 'macOS Contacts', format: onOff },
  'contactSources.direct.outlookContacts': { group: 'Contacts', label: 'Outlook Contacts', format: onOff },
  'contactSources.direct.googleContacts': { group: 'Contacts', label: 'Google Contacts', format: onOff },
  'contactSources.direct.iphoneContacts': { group: 'Contacts', label: 'iPhone Contacts', format: onOff },
  'contactSources.direct.androidContacts': { group: 'Contacts', label: 'Android Phone Contacts', format: onOff },
  'contactSources.direct.gmailContacts': { group: 'Contacts', label: 'Gmail Contacts', format: onOff },
  'contactSources.inferred.outlookEmails': {
    group: 'Contacts',
    label: 'Auto-discover from Outlook emails',
    format: onOff,
  },
  'contactSources.inferred.gmailEmails': {
    group: 'Contacts',
    label: 'Auto-discover from Gmail emails',
    format: onOff,
  },
  'contactSources.inferred.messages': {
    group: 'Contacts',
    label: 'Auto-discover from Messages / SMS',
    format: onOff,
  },

  // --- Setup ---------------------------------------------------------------
  // Not a Settings control: asked once during onboarding ("What phone do you
  // use?") and read afterwards to decide which contact toggles appear.
  phone_type: {
    group: 'Setup',
    label: 'Phone',
    format: options({ iphone: 'iPhone', android: 'Android' }),
  },
  // Internal restart markers written by the main process during the macOS Full
  // Disk Access relaunch. Labelled rather than hidden: a person reading their
  // own stored settings should see everything that is stored, and an unlabelled
  // key would land in "Other settings" and look like a defect.
  'onboarding.resumeStep': { group: 'Setup', label: 'Onboarding resume point' },
  'onboarding.resumeSavedAt': {
    group: 'Setup',
    label: 'Onboarding resume saved',
    format: (v) =>
      typeof v === 'number' ? new Date(v).toLocaleString('en-US') : formatScalar(v),
  },
  // Read by src/hooks/audit/useAuditAddressForm.ts; no rendered control.
  'audit.startDateDefault': {
    group: 'General',
    label: 'Audit start date default',
    format: options({ manual: 'Enter manually', auto: 'Detect automatically' }),
  },
};

// ---------------------------------------------------------------------------
// Flatten + resolve
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Flatten the blob to leaf paths.
 *
 * Recursion stops at anything that is not a plain object, so `null`, arrays and
 * scalars are all leaves. That is what makes "an unmapped key is never dropped"
 * true for a nested shape as well as a top-level one: a new object grows new
 * leaf rows rather than one unreadable blob.
 *
 * An EMPTY object is itself a leaf. Recursing into it would produce no rows and
 * the key would vanish silently, which is the failure this page must not have.
 */
export function flattenPreferences(
  value: unknown,
  prefix = ''
): Array<{ path: string; value: unknown }> {
  if (!isPlainObject(value)) {
    return prefix ? [{ path: prefix, value }] : [];
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return prefix ? [{ path: prefix, value }] : [];
  }
  return keys.flatMap((key) =>
    flattenPreferences(value[key], prefix ? `${prefix}.${key}` : key)
  );
}

/** Turn a dotted path into something readable when no label is recorded. */
export function humanizePath(path: string): string {
  return path
    .split('.')
    .map((segment) =>
      segment
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\b./g, (c) => c.toUpperCase())
    )
    .join(' › ');
}

/**
 * Resolve one person's whole blob for display, in group order then path order.
 *
 * Nothing is dropped. A path with no entry in PREFERENCE_LABELS is reported
 * with `mapped: false` and a humanised label, and the caller puts it under
 * "Other settings" — visible, readable, and obviously not yet designed for.
 */
export function resolvePreferences(preferences: unknown): ResolvedPreference[] {
  const groupRank = new Map<string, number>(
    GROUP_ORDER.map((g, i) => [g, i] as const)
  );

  const rows = flattenPreferences(preferences).map(({ path, value }) => {
    const entry = PREFERENCE_LABELS[path];
    return {
      path,
      group: entry?.group ?? UNMAPPED_GROUP,
      label: entry?.label ?? humanizePath(path),
      display: entry?.format ? entry.format(value) : formatScalar(value),
      mapped: Boolean(entry),
    };
  });

  return rows.sort((a, b) => {
    const ga = groupRank.get(a.group) ?? GROUP_ORDER.length;
    const gb = groupRank.get(b.group) ?? GROUP_ORDER.length;
    if (ga !== gb) return ga - gb;
    return a.label.localeCompare(b.label);
  });
}

/** The resolved rows, bucketed into sections in GROUP_ORDER order. */
export function groupPreferences(
  preferences: unknown
): Array<{ group: string; rows: ResolvedPreference[] }> {
  const resolved = resolvePreferences(preferences);
  const out: Array<{ group: string; rows: ResolvedPreference[] }> = [];
  for (const row of resolved) {
    const last = out[out.length - 1];
    if (last && last.group === row.group) last.rows.push(row);
    else out.push({ group: row.group, rows: [row] });
  }
  return out;
}
