/**
 * BACKLOG-2407 — capture `ContactsContract.Contacts.LOOKUP_KEY`.
 *
 * WHY THIS IS WORTH A TEST FOR A VALUE NOTHING READS. `lookupKey` is the
 * identifier Android designates as sync-stable; `_ID`, which the desktop keys
 * on, explicitly is not. It is read through an untyped runtime accessor because
 * `expo-contacts@55.0.9` does not declare the field (`Contacts.d.ts:377-382`
 * declares only `id`), so nothing in the type system would notice if a future
 * upgrade renamed it and the capture silently became `undefined` for everyone.
 * These assertions are the only thing standing between that and losing an
 * identifier that cannot be re-read once the phone is gone.
 *
 * ⚠️ Capturing it does NOT by itself survive a device swap — the stored key is
 * `android-{deviceId}-{id}` with a desktop-minted per-pairing deviceId. That
 * decision is recorded at the point the key is built (electron
 * localSyncService.ts) and is deliberately out of scope here.
 *
 * ASSERTION STYLE: exact ID SETS, never counts.
 */

// --- Mock expo-contacts ------------------------------------------------------
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockGetContacts = jest.fn();

jest.mock('expo-contacts', () => ({
  getPermissionsAsync: () => mockGetPermissions(),
  requestPermissionsAsync: () => mockRequestPermissions(),
  getContactsAsync: () => mockGetContacts(),
  Fields: {
    FirstName: 'firstName',
    LastName: 'lastName',
    PhoneNumbers: 'phoneNumbers',
    Emails: 'emails',
    Company: 'company',
    JobTitle: 'jobTitle',
  },
}));

import { readContacts } from '../contactReader';

type RawContact = Record<string, unknown>;

/**
 * A raw record as the native module delivers it — `lookupKey` present as an
 * untyped runtime field, exactly as `Contact.kt:335` emits it.
 */
function raw(id: string, name: string, lookupKey?: unknown): RawContact {
  const c: RawContact = { id, name, phoneNumbers: [], emails: [] };
  if (lookupKey !== undefined) c.lookupKey = lookupKey;
  return c;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPermissions.mockResolvedValue({ status: 'granted' });
});

describe('readContacts — lookupKey capture (BACKLOG-2407)', () => {
  it('captures the lookup key for every contact that has one', async () => {
    mockGetContacts.mockResolvedValue({
      data: [
        raw('101', 'Ada Lovelace', '0r1-4A3B2C'),
        raw('102', 'Grace Hopper', '0r2-9F8E7D'),
      ],
    });

    const contacts = await readContacts();

    // The full id -> lookupKey mapping. A count would pass while two contacts
    // had swapped keys, which is the failure that would make the capture worse
    // than not having it.
    expect(new Map(contacts.map((c) => [c.id, c.lookupKey]))).toEqual(
      new Map([
        ['101', '0r1-4A3B2C'],
        ['102', '0r2-9F8E7D'],
      ])
    );
  });

  it('keeps a contact whose lookupKey is missing — it is NOT skipped', async () => {
    // Structural, not an OEM quirk: expo-contacts assigns lookupKey only inside
    // the StructuredName branch (`Contact.kt:89`), so an organization-only or
    // phone-only contact has none by construction. Dropping a real contact over
    // a missing capture would be a far worse trade than losing the capture —
    // deliberately unlike the id guard, where a missing id collapses every
    // affected contact onto one key.
    mockGetContacts.mockResolvedValue({
      data: [
        raw('101', 'Ada Lovelace', '0r1-4A3B2C'),
        raw('201', 'Org Only LLC'), // no structured name -> no lookupKey
      ],
    });

    const contacts = await readContacts();

    expect(new Set(contacts.map((c) => c.id))).toEqual(new Set(['101', '201']));
    expect(contacts.find((c) => c.id === '201')!.lookupKey).toBeUndefined();
    expect(contacts.find((c) => c.id === '101')!.lookupKey).toBe('0r1-4A3B2C');
  });

  it('treats a non-string or blank lookupKey as absent', async () => {
    // The field is untyped at runtime. Anything that is not a non-empty string
    // must become `undefined` rather than reaching the desktop as `null`, `42`
    // or `"   "` and being stored as a bogus identifier.
    mockGetContacts.mockResolvedValue({
      data: [
        raw('301', 'Null Key', null),
        raw('302', 'Numeric Key', 42),
        raw('303', 'Blank Key', '   '),
        raw('304', 'Empty Key', ''),
        raw('305', 'Padded Key', '  0r5-PADDED  '),
      ],
    });

    const contacts = await readContacts();

    expect(new Map(contacts.map((c) => [c.id, c.lookupKey]))).toEqual(
      new Map([
        ['301', undefined],
        ['302', undefined],
        ['303', undefined],
        ['304', undefined],
        // Trimmed, because a stored key with surrounding whitespace would not
        // compare equal to the same key read back cleanly later.
        ['305', '0r5-PADDED'],
      ])
    );
  });

  it('still skips id-less contacts — the existing guard is unchanged', async () => {
    // Regression guard: the lookupKey handling must not have softened the id
    // guard, which exists for a different and stronger reason (BACKLOG-2208).
    mockGetContacts.mockResolvedValue({
      data: [
        raw('101', 'Valid', '0r1-4A3B2C'),
        { id: undefined, name: 'No Id', phoneNumbers: [], emails: [], lookupKey: '0rX' },
        { id: '   ', name: 'Blank Id', phoneNumbers: [], emails: [], lookupKey: '0rY' },
      ],
    });

    const contacts = await readContacts();

    expect(new Set(contacts.map((c) => c.id))).toEqual(new Set(['101']));
  });

  it('survives a re-read of the same address book with identical keys', async () => {
    const data = [
      raw('101', 'Ada Lovelace', '0r1-4A3B2C'),
      raw('201', 'Org Only LLC'),
    ];
    mockGetContacts.mockResolvedValue({ data });

    const first = await readContacts();
    const second = await readContacts();

    // Idempotence in the identifiers is the property that makes them usable as
    // a key later; asserted as the whole set both times.
    const asPairs = (cs: typeof first) =>
      cs.map((c) => [c.id, c.lookupKey]).sort();
    expect(asPairs(first)).toEqual([
      ['101', '0r1-4A3B2C'],
      ['201', undefined],
    ]);
    expect(asPairs(second)).toEqual(asPairs(first));
  });
});
