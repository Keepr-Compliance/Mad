/**
 * BACKLOG-2208 — contactReader id guard.
 *
 * The desktop dedups on `android-{deviceId}-{contact.id}`, so a contact with a
 * missing/blank id would collapse every id-less contact into one record (churn).
 * readContacts must SKIP such contacts (and still map valid ones correctly).
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

/** A raw expo-contacts contact record. */
type RawContact = Record<string, unknown>;

function raw(id: unknown, name: string, phone?: string): RawContact {
  return {
    id,
    name,
    phoneNumbers: phone ? [{ number: phone, label: 'mobile' }] : [],
    emails: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPermissions.mockResolvedValue({ status: 'granted' });
});

describe('readContacts — missing id guard', () => {
  it('skips contacts with an undefined or blank id and keeps valid ones', async () => {
    mockGetContacts.mockResolvedValue({
      data: [
        raw('c1', 'Alice', '+15550000001'),
        raw(undefined, 'No Id Bob', '+15550000002'),
        raw('', 'Blank Id Carol', '+15550000003'),
        raw('   ', 'Whitespace Dan', '+15550000004'),
        raw('c5', 'Eve', '+15550000005'),
      ],
    });

    const contacts = await readContacts();

    expect(contacts.map((c) => c.id).sort()).toEqual(['c1', 'c5']);
    // Every returned contact carries a usable stable id.
    for (const c of contacts) {
      expect(typeof c.id).toBe('string');
      expect(c.id.trim().length).toBeGreaterThan(0);
    }
  });

  it('maps a valid contact into SyncContact shape (id, name, phones, emails)', async () => {
    mockGetContacts.mockResolvedValue({
      data: [
        {
          id: 'c9',
          name: 'Jane Doe',
          phoneNumbers: [{ number: '+15551112222', label: 'work' }],
          emails: [{ email: 'jane@example.com', label: 'home' }],
          company: 'Acme',
          jobTitle: 'CEO',
        },
      ],
    });

    const [c] = await readContacts();

    expect(c).toEqual({
      id: 'c9',
      displayName: 'Jane Doe',
      phones: [{ number: '+15551112222', label: 'work' }],
      emails: [{ address: 'jane@example.com', label: 'home' }],
      company: 'Acme',
      title: 'CEO',
    });
  });

  it('returns [] when permission is not granted', async () => {
    mockGetPermissions.mockResolvedValue({ status: 'denied' });
    mockRequestPermissions.mockResolvedValue({ status: 'denied' });

    const contacts = await readContacts();

    expect(contacts).toEqual([]);
    expect(mockGetContacts).not.toHaveBeenCalled();
  });
});
