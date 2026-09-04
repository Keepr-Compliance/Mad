/**
 * The blob becomes labelled settings, and nothing is lost on the way.
 * BACKLOG-3079.
 *
 * Three properties, each of which fails silently if it is not asserted:
 *
 *   1. NOTHING IS DROPPED. The count of rendered rows equals the count of leaf
 *      paths in the blob. Pre-registered, so an edit to the fixture that
 *      removes a key cannot quietly weaken the claim.
 *   2. NO RAW JSON REACHES THE READER. Every value is formatted; an object that
 *      survives to a leaf is named, not stringified.
 *   3. THE LABELS ARE THE DESKTOP'S. Asserted for the keys whose wording was
 *      transcribed, so a rewrite of one surface shows up as a red test rather
 *      than as two screens that quietly disagree.
 */

import {
  GROUP_ORDER,
  PREFERENCE_LABELS,
  UNMAPPED_GROUP,
  flattenPreferences,
  formatScalar,
  groupPreferences,
  humanizePath,
  resolvePreferences,
} from '@/lib/account/preferenceLabels';
import {
  FULL_PREFERENCES,
  FULL_PREFERENCES_LEAF_COUNT,
  SPARSE_PREFERENCES,
} from '../../fixtures/account';

function byPath(rows: ReturnType<typeof resolvePreferences>) {
  return new Map(rows.map((r) => [r.path, r] as const));
}

// ---------------------------------------------------------------------------
// 1. Nothing is dropped
// ---------------------------------------------------------------------------

describe('flattenPreferences', () => {
  it('produces exactly one row per leaf, at the pre-registered count', () => {
    expect(flattenPreferences(FULL_PREFERENCES)).toHaveLength(FULL_PREFERENCES_LEAF_COUNT);
  });

  it('keeps an explicit null as a leaf rather than pruning it', () => {
    // messageImport.android.filters.maxMessages is null in prod for the
    // "Unlimited" setting. Pruning it would silently delete a real choice.
    const paths = flattenPreferences(FULL_PREFERENCES).map((r) => r.path);
    expect(paths).toContain('messageImport.android.filters.maxMessages');
  });

  it('keeps an EMPTY object as a leaf', () => {
    // Recursing into {} yields no rows, so the key would vanish. That is the
    // exact "dropped silently" failure this page must not have.
    expect(flattenPreferences({ someFeature: {} })).toEqual([
      { path: 'someFeature', value: {} },
    ]);
  });

  it('descends arbitrarily deep', () => {
    expect(flattenPreferences({ a: { b: { c: { d: 1 } } } })).toEqual([
      { path: 'a.b.c.d', value: 1 },
    ]);
  });

  it('returns nothing for an empty blob', () => {
    expect(flattenPreferences({})).toEqual([]);
  });
});

describe('resolvePreferences — nothing is dropped', () => {
  it('renders a row for every leaf', () => {
    expect(resolvePreferences(FULL_PREFERENCES)).toHaveLength(FULL_PREFERENCES_LEAF_COUNT);
  });

  it('renders every leaf of a sparse blob too', () => {
    const rows = resolvePreferences(SPARSE_PREFERENCES);
    expect(rows.map((r) => r.path).sort()).toEqual([
      'contactSources.direct.macosContacts',
      'phone_type',
    ]);
  });

  it('renders nothing for an empty blob', () => {
    expect(resolvePreferences({})).toEqual([]);
  });

  it('survives a null blob without throwing', () => {
    expect(resolvePreferences(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. An unmapped key is visible, readable, and marked
// ---------------------------------------------------------------------------

describe('an unmapped key', () => {
  const withUnknown = { ...SPARSE_PREFERENCES, brandNewFeature: { someToggle: true } };

  it('is not dropped', () => {
    const rows = resolvePreferences(withUnknown);
    expect(rows.map((r) => r.path)).toContain('brandNewFeature.someToggle');
  });

  it('lands in the catch-all group', () => {
    const row = byPath(resolvePreferences(withUnknown)).get('brandNewFeature.someToggle');
    expect(row?.group).toBe(UNMAPPED_GROUP);
    expect(row?.mapped).toBe(false);
  });

  it('gets a readable label rather than a dotted path', () => {
    const row = byPath(resolvePreferences(withUnknown)).get('brandNewFeature.someToggle');
    expect(row?.label).toBe('Brand New Feature › Some Toggle');
  });

  it('gets a formatted value rather than raw JSON', () => {
    const row = byPath(resolvePreferences(withUnknown)).get('brandNewFeature.someToggle');
    expect(row?.display).toBe('On');
  });

  it('every mapped key reports mapped: true, so the flag means something', () => {
    const rows = resolvePreferences(FULL_PREFERENCES);
    expect(rows.filter((r) => !r.mapped).map((r) => r.path)).toEqual([]);
  });
});

describe('humanizePath', () => {
  it.each([
    ['phone_type', 'Phone Type'],
    ['contactSources.direct.iphoneContacts', 'Contact Sources › Direct › Iphone Contacts'],
    ['a.b', 'A › B'],
  ])('%s -> %s', (input, expected) => {
    expect(humanizePath(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 3. No raw JSON reaches the reader
// ---------------------------------------------------------------------------

describe('formatScalar', () => {
  it.each([
    [true, 'On'],
    [false, 'Off'],
    [null, 'Not set'],
    [undefined, 'Not set'],
    ['', 'Not set'],
    ['macos-native', 'macos-native'],
    [7, '7'],
    [[], 'None'],
    [['a', 'b'], 'a, b'],
  ])('%p -> %s', (input, expected) => {
    expect(formatScalar(input)).toBe(expected);
  });

  it('names an object instead of stringifying it', () => {
    expect(formatScalar({ nested: 1 })).toBe('Saved (not shown here)');
    expect(formatScalar({ nested: 1 })).not.toContain('{');
  });

  it('no rendered value anywhere in a full blob looks like JSON', () => {
    for (const row of resolvePreferences(FULL_PREFERENCES)) {
      expect(row.display).not.toMatch(/[{}[\]]/);
      expect(row.display).not.toBe('[object Object]');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The labels and values are the desktop's
// ---------------------------------------------------------------------------

describe('values render the way the desktop renders them', () => {
  const rows = byPath(resolvePreferences(FULL_PREFERENCES));

  it.each([
    ['sync.autoSyncOnLogin', 'Auto-Sync on Startup', 'On'],
    ['updates.autoDownload', 'Auto-download Updates', 'On'],
    ['contactAutoRole.enabled', 'Auto-fill Contact Roles', 'On'],
    ['export.defaultFormat', 'Export format', 'One PDF'],
    ['export.contentType', 'Export content', 'Both'],
    ['export.attachmentType', 'Export attachments', 'All'],
    ['export.emailExportMode', 'Export email mode', 'Individual'],
    ['messages.source', 'Import Source', 'macOS Messages'],
    ['integrations.iphoneSyncEnabled', 'iPhone Sync (USB)', 'On'],
    ['contactSources.direct.iphoneContacts', 'iPhone Contacts', 'On'],
    ['contactSources.direct.outlookContacts', 'Outlook Contacts', 'Off'],
    ['contactSources.direct.googleContacts', 'Google Contacts', 'Off'],
    ['phone_type', 'Phone', 'Android'],
    ['audit.startDateDefault', 'Audit start date default', 'Enter manually'],
  ])('%s -> "%s" = "%s"', (path, label, display) => {
    expect(rows.get(path)).toMatchObject({ label, display });
  });

  it('formats a message lookback the way the dropdown reads', () => {
    expect(rows.get('messageImport.filters.lookbackMonths')?.display).toBe('Last 9 months');
  });

  it('formats a message cap with thousands separators', () => {
    expect(rows.get('messageImport.filters.maxMessages')?.display).toBe('50,000');
  });

  it('renders an explicit null lookback as "All time", not "Not set"', () => {
    // In the desktop, an ABSENT lookback means "Last 3 months" and only an
    // explicit null means All time. This page shows only what is STORED, so an
    // absent key produces no row at all and a stored null produces this.
    expect(rows.get('messageImport.android.filters.lookbackMonths')?.display).toBe('All time');
  });

  it('renders an explicit null message cap as "Unlimited"', () => {
    expect(rows.get('messageImport.android.filters.maxMessages')?.display).toBe('Unlimited');
  });

  it('renders the 12-month email cache as "1 year", as the dropdown does', () => {
    expect(rows.get('emailCache.durationMonths')?.display).toBe('1 year');
  });

  it('renders a 6-month email cache as "6 months"', () => {
    const r = byPath(resolvePreferences({ emailCache: { durationMonths: 6 } }));
    expect(r.get('emailCache.durationMonths')?.display).toBe('6 months');
  });

  it('renders a 1-month email cache without a plural', () => {
    const r = byPath(resolvePreferences({ emailCache: { durationMonths: 1 } }));
    expect(r.get('emailCache.durationMonths')?.display).toBe('1 month');
  });

  it('falls back to the raw value for an option the desktop does not list', () => {
    // A future export format must not render as "undefined".
    const r = byPath(resolvePreferences({ export: { defaultFormat: 'zip-bundle' } }));
    expect(r.get('export.defaultFormat')?.display).toBe('zip-bundle');
  });
});

// ---------------------------------------------------------------------------
// 5. Grouping
// ---------------------------------------------------------------------------

describe('groupPreferences', () => {
  it('emits sections in the desktop tab order', () => {
    const groups = groupPreferences(FULL_PREFERENCES).map((s) => s.group);
    const ranks = groups.map((g) => GROUP_ORDER.indexOf(g as never));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('emits each group exactly once', () => {
    const groups = groupPreferences(FULL_PREFERENCES).map((s) => s.group);
    expect(new Set(groups).size).toBe(groups.length);
  });

  it('puts the catch-all last', () => {
    const groups = groupPreferences({
      ...FULL_PREFERENCES,
      brandNewFeature: true,
    }).map((s) => s.group);
    expect(groups[groups.length - 1]).toBe(UNMAPPED_GROUP);
  });

  it('accounts for every leaf across all sections', () => {
    const total = groupPreferences(FULL_PREFERENCES).reduce((n, s) => n + s.rows.length, 0);
    expect(total).toBe(FULL_PREFERENCES_LEAF_COUNT);
  });
});

describe('the label map itself', () => {
  it('records a renderable group and a non-empty label for every entry', () => {
    for (const [path, entry] of Object.entries(PREFERENCE_LABELS)) {
      expect(GROUP_ORDER).toContain(entry.group as never);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(path).not.toBe('');
    }
  });

  it('never files a mapped key under the catch-all group', () => {
    const misfiled = Object.entries(PREFERENCE_LABELS)
      .filter(([, e]) => e.group === UNMAPPED_GROUP)
      .map(([p]) => p);
    expect(misfiled).toEqual([]);
  });

  it('covers every top-level key production actually stores', () => {
    // Transcribed 2026-09-04: jsonb_object_keys over every user_preferences row.
    // A key here with no mapped leaf would render under "Other settings" for a
    // real customer, which is the state this item exists to end.
    const LIVE_TOP_LEVEL_KEYS = [
      'contactSources', 'export', 'phone_type', 'sync', 'messages',
      'contactAutoRole', 'updates', 'onboarding', 'audit', 'emailCache',
      'integrations', 'emailSync', 'messageImport',
    ];
    const mappedTopLevel = new Set(
      Object.keys(PREFERENCE_LABELS).map((p) => p.split('.')[0])
    );
    expect([...LIVE_TOP_LEVEL_KEYS].filter((k) => !mappedTopLevel.has(k))).toEqual([]);
  });
});
