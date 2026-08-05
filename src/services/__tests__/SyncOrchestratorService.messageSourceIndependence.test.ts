/**
 * BACKLOG-2477 — contacts are checkboxes; the message source is a radio button.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE PINS
 * ---------------------------------------------------------------------------
 * `messages.source` is exclusive by construction — `macos-native` OR
 * `iphone-sync` OR `android-companion`, picking one unpicks the others. That is
 * correct for text messages, which genuinely come from one place.
 *
 * `contactSources.direct.*` is a set of independent booleans. Contacts have
 * never been exclusive: a user can hold Mac and Outlook and Google contacts at
 * once, each tagged with its source, each filterable.
 *
 * The contacts sync used to consult BOTH. Phase 1 read
 * `importSource !== 'iphone-sync' && sourcePrefs.macosContacts`, so a user who
 * ticked Mac Contacts and then told the app their texts come from an iPhone got
 * no Mac contacts — with nothing on screen saying so, and no way to override it
 * from the Contacts checkboxes.
 *
 * The assertion is therefore not "macOS contacts can be turned off". It is that
 * **moving the message-source radio button does not move the imported contact
 * id set, at all, in any checkbox state.**
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORCHESTRATOR IS **NOT** MOCKED — this is the point of the suite
 * ---------------------------------------------------------------------------
 * The decision under test lives in `SyncOrchestratorService`'s own preference
 * resolution (`getContactsSyncPreferences`) and in the Phase 1 gate that reads
 * it. Mocking either would make this suite assert its own mock.
 *
 * So the REAL registered `contacts` sync function runs, and the ONLY preference
 * mock is `window.api.preferences.get` — one level further out, at the actual
 * IPC boundary. Everything between that boundary and the phase gates is under
 * test.
 *
 * ---------------------------------------------------------------------------
 * FIXTURE PROVENANCE
 * ---------------------------------------------------------------------------
 * - The `{ success, preferences }` envelope is the shape `window.api.preferences.get`
 *   returns, as consumed at `SyncOrchestratorService.ts:151-155,180-181`.
 * - `{ contactSources: { direct: {...} } }` is what onboarding actually writes:
 *   `ContactSourceStep.buildDirectContactSourcePrefs` (`ContactSourceStep.tsx:219-230`)
 *   persists ONLY the visible keys, at `:266` (Skip) and `:447` (Continue). That
 *   is why the "no contactSources key at all" row below is a REAL state and not
 *   a hypothetical.
 * - `{ messages: { source } }` is what `usePhoneTypeApi.ts:188-191` writes at
 *   onboarding and what `ImportSourceSettings.tsx:168-173` writes from the
 *   Settings radio. ABSENT is a real state too: every install that predates the
 *   BACKLOG-2408 write has no such key.
 * - The contact ids are readable stand-ins. Real `external_contacts.id` values
 *   are uuids (`externalContactDbService.ts:450,515,675`), so they carry no
 *   source information and would make a failure unreadable. What is transcribed
 *   is WHICH SOURCE each endpoint contributes: `contacts.syncExternal` writes
 *   `source='macos'`, `syncOutlookContacts` writes `'outlook'`,
 *   `syncGoogleContacts` writes `'google_contacts'` — the `ExternalContactSource`
 *   union at `externalContactDbService.ts:44`.
 *
 * The macOS source deliberately carries TWO records and the two cloud sources
 * carry one each. So "macOS only" and "cloud only" both return a set of size 2:
 * a count cannot tell them apart, and only the identity can. That is exactly
 * this bug's shape — the wrong contacts, not the wrong number of them.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ImportSource } from '../settingsService';

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: jest.fn(),
}));

jest.mock('../../utils/platform', () => ({
  isMacOS: jest.fn(() => true),
}));

// ---------------------------------------------------------------------------
// THE CORPUS — one id per record, distinct per source.
// ---------------------------------------------------------------------------
const MACOS_IDS = ['macos-ana', 'macos-ben'];
const OUTLOOK_IDS = ['outlook-cleo'];
const GOOGLE_IDS = ['google-dev'];

const ALL_IDS = [...GOOGLE_IDS, ...MACOS_IDS, ...OUTLOOK_IDS].sort();
const CLOUD_ONLY = [...GOOGLE_IDS, ...OUTLOOK_IDS].sort();
const MACOS_ONLY = [...MACOS_IDS].sort();

/** Contacts that reached the database on the run being measured. */
let imported: string[] = [];

/** THE ONLY PREFERENCE MOCK. The orchestrator's own resolution runs for real. */
let mockPreferences: Record<string, any> = {};

Object.defineProperty(global, 'window', {
  value: {
    api: {
      preferences: {
        get: jest.fn(() => Promise.resolve({ success: true, preferences: mockPreferences })),
      },
      contacts: {
        syncExternal: jest.fn(() => {
          imported.push(...MACOS_IDS);
          return Promise.resolve({ success: true, inserted: MACOS_IDS.length, total: MACOS_IDS.length });
        }),
        syncOutlookContacts: jest.fn(() => {
          imported.push(...OUTLOOK_IDS);
          return Promise.resolve({ success: true, count: OUTLOOK_IDS.length });
        }),
        syncGoogleContacts: jest.fn(() => {
          imported.push(...GOOGLE_IDS);
          return Promise.resolve({ success: true, count: GOOGLE_IDS.length });
        }),
        forceReimport: jest.fn(() => Promise.resolve({ success: true, cleared: 0 })),
      },
      transactions: { scan: jest.fn(), precacheEmails: jest.fn().mockResolvedValue({ success: true }) },
      messages: { importMacOSMessages: jest.fn(), onImportProgress: jest.fn() },
      notification: { send: jest.fn() },
      system: { reindexDatabase: jest.fn() },
      databaseBackup: { backup: jest.fn(), restore: jest.fn() },
      privacy: { exportData: jest.fn(), onExportProgress: jest.fn() },
    },
  },
  writable: true,
});

const { syncOrchestrator } =
  require('../SyncOrchestratorService') as typeof import('../SyncOrchestratorService');

const USER = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Build the preference bag the way its real writers do: absent means absent.
 * `direct === undefined` omits the whole `contactSources` key, which is what a
 * pre-BACKLOG-2476 install looks like.
 */
function prefs(
  source: ImportSource | undefined,
  direct: Record<string, boolean> | undefined,
): Record<string, any> {
  return {
    ...(source ? { messages: { source } } : {}),
    ...(direct ? { contactSources: { direct } } : {}),
  };
}

/** The EXACT set of contacts a sync run imported. Identity, never a count. */
async function importedIds(): Promise<string[]> {
  imported = [];
  syncOrchestrator.initializeSyncFunctions();
  const syncFn = (syncOrchestrator as any).syncFunctions.get('contacts');
  await syncFn(USER, jest.fn());
  return [...imported].sort();
}

beforeEach(() => {
  syncOrchestrator.reset();
  (syncOrchestrator as any).syncFunctions = new Map();
  (syncOrchestrator as any).initialized = false;
  mockPreferences = {};
  imported = [];
  jest.clearAllMocks();
  require('../../utils/platform').isMacOS.mockReturnValue(true);
});

// ===========================================================================
// THE MATRIX — swept, not sampled.
//
// 4 message sources (3 values + ABSENT) x 5 checkbox states = 20 points.
// Expected sets are written out literally, so a bug in the gate cannot also
// produce the expectation that hides it. Every expected set is identical down a
// column: that IS the property under test.
// ===========================================================================

const MESSAGE_SOURCES: Array<ImportSource | undefined> = [
  undefined,
  'macos-native',
  'iphone-sync',
  'android-companion',
];

type CheckboxState = {
  label: string;
  direct: Record<string, boolean> | undefined;
  expected: string[];
};

const CHECKBOX_STATES: CheckboxState[] = [
  {
    label: 'every contact source ticked',
    direct: { macosContacts: true, outlookContacts: true, googleContacts: true },
    expected: ALL_IDS,
  },
  {
    // Same SIZE as the row below it, different identity. A count cannot
    // distinguish these two rows; only the ids can.
    label: 'macOS unticked, both cloud sources ticked',
    direct: { macosContacts: false, outlookContacts: true, googleContacts: true },
    expected: CLOUD_ONLY,
  },
  {
    label: 'macOS ticked, both cloud sources unticked',
    direct: { macosContacts: true, outlookContacts: false, googleContacts: false },
    expected: MACOS_ONLY,
  },
  {
    label: 'every contact source unticked',
    direct: { macosContacts: false, outlookContacts: false, googleContacts: false },
    expected: [],
  },
  {
    // Onboarding skipped entirely — no `contactSources` key was ever written.
    // The orchestrator fails OPEN here (`SyncOrchestratorService.ts:170-172`).
    label: 'no contactSources key at all',
    direct: undefined,
    expected: ALL_IDS,
  },
];

describe('BACKLOG-2477 — the message source x contact checkbox matrix (macOS)', () => {
  for (const state of CHECKBOX_STATES) {
    for (const source of MESSAGE_SOURCES) {
      it(`${state.label}; messages.source=${source ?? 'ABSENT'}`, async () => {
        mockPreferences = prefs(source, state.direct);
        expect(await importedIds()).toEqual(state.expected);
      });
    }
  }
});

// ===========================================================================
describe("BACKLOG-2477 — the founder's case", () => {
  /**
   * Mac Contacts ticked; the user then tells the app their texts come from an
   * iPhone — by pairing, by the Settings radio, or by answering the onboarding
   * phone-type step on Windows.
   *
   * Before the fix the Phase 1 gate was
   * `macOS && importSource !== 'iphone-sync' && sourcePrefs.macosContacts`,
   * so this returned CLOUD_ONLY: the Mac address book stopped feeding contacts
   * because of an answer about text messages.
   */
  it('keeps every Mac contact when the message source is switched to iPhone', async () => {
    mockPreferences = prefs('iphone-sync', {
      macosContacts: true,
      outlookContacts: true,
      googleContacts: true,
    });
    expect(await importedIds()).toEqual(ALL_IDS);
  });

  it('imports the SAME id set under all four message sources', async () => {
    const direct = { macosContacts: true, outlookContacts: true, googleContacts: true };
    const sets: string[][] = [];
    for (const source of MESSAGE_SOURCES) {
      mockPreferences = prefs(source, direct);
      sets.push(await importedIds());
    }
    // Every run returned the same set — and that set is the full corpus, not an
    // empty one. Equality alone would pass if the sync imported nothing at all.
    for (const set of sets) {
      expect(set).toEqual(ALL_IDS);
    }
    expect(new Set(sets.map((s) => s.join(','))).size).toBe(1);
  });
});

// ===========================================================================
describe('BACKLOG-2477 — Windows: no Mac address book to gate', () => {
  /**
   * Phase 1 is still platform-gated, and must stay that way: there is no macOS
   * address book on Windows to read. What must NOT happen is the message source
   * changing the answer here either.
   */
  beforeEach(() => {
    require('../../utils/platform').isMacOS.mockReturnValue(false);
  });

  for (const source of MESSAGE_SOURCES) {
    it(`imports the cloud sources only; messages.source=${source ?? 'ABSENT'}`, async () => {
      mockPreferences = prefs(source, {
        macosContacts: true,
        outlookContacts: true,
        googleContacts: true,
      });
      expect(await importedIds()).toEqual(CLOUD_ONLY);
    });
  }
});
