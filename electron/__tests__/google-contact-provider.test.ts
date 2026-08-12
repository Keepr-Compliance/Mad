/**
 * Unit tests for GoogleContactProvider (TASK-2301)
 *
 * Tests the Google People API contact fetch provider including:
 * - canSync: token checks, scope validation, token refresh
 * - fetchContacts: API calls, pagination, field mapping
 * - Error handling: 403 scope errors, network errors
 */

// ============================================
// MOCKS (must be before imports)
// ============================================

jest.mock('../services/logService', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetOAuthToken = jest.fn();
const mockUpdateOAuthToken = jest.fn();
jest.mock('../services/databaseService', () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...args: unknown[]) => mockGetOAuthToken(...args),
    updateOAuthToken: (...args: unknown[]) => mockUpdateOAuthToken(...args),
  },
}));

const mockRefreshAccessToken = jest.fn();
jest.mock('../services/googleAuthService', () => ({
  __esModule: true,
  default: {
    refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
  },
}));

// Mock googleapis People API
const mockConnectionsList = jest.fn();
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        on: jest.fn(),
      })),
    },
    people: jest.fn().mockImplementation(() => ({
      people: {
        connections: {
          list: (...args: unknown[]) => mockConnectionsList(...args),
        },
      },
    })),
  },
}));

jest.mock('@sentry/electron/main', () => ({
  captureException: jest.fn(),
}));

import { GoogleContactProvider } from '../services/providers/googleContactProvider';

// ============================================
// TEST HELPERS
// ============================================

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

function createMockTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-1',
    user_id: TEST_USER_ID,
    provider: 'google',
    purpose: 'mailbox',
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    token_expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    scopes_granted: 'openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/contacts.readonly',
    connected_email_address: 'user@gmail.com',
    mailbox_connected: true,
    is_active: true,
    token_refresh_failed_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockPerson(overrides: Record<string, unknown> = {}) {
  return {
    resourceName: 'people/c123456',
    names: [
      {
        displayName: 'John Doe',
        metadata: { primary: true },
      },
    ],
    emailAddresses: [
      { value: 'john@example.com' },
      { value: 'johndoe@work.com' },
    ],
    phoneNumbers: [
      { value: '+15555550112' },
    ],
    organizations: [
      {
        name: 'Acme Corp',
        metadata: { primary: true },
      },
    ],
    ...overrides,
  };
}

// ============================================
// TESTS
// ============================================

describe('GoogleContactProvider', () => {
  let provider: GoogleContactProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new GoogleContactProvider();
    // Set env vars for OAuth2 client
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  });

  // ============================================
  // Properties
  // ============================================

  describe('properties', () => {
    it('should have source = google_contacts', () => {
      expect(provider.source).toBe('google_contacts');
    });

    it('should have preferenceKey = googleContacts', () => {
      expect(provider.preferenceKey).toBe('googleContacts');
    });
  });

  // ============================================
  // canSync
  // ============================================

  describe('canSync', () => {
    it('should return ready=true when token exists with contacts.readonly scope', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      const result = await provider.canSync(TEST_USER_ID);

      expect(result.ready).toBe(true);
      expect(mockGetOAuthToken).toHaveBeenCalledWith(TEST_USER_ID, 'google', 'mailbox');
    });

    it('should return ready=false with reconnectRequired when no token exists', async () => {
      mockGetOAuthToken.mockResolvedValue(null);

      const result = await provider.canSync(TEST_USER_ID);

      expect(result.ready).toBe(false);
      expect(result.reconnectRequired).toBe(true);
      expect(result.error).toContain('No Google OAuth token found');
    });

    it('should return ready=false with reconnectRequired when token has no access_token', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord({ access_token: '' }));

      const result = await provider.canSync(TEST_USER_ID);

      expect(result.ready).toBe(false);
      expect(result.reconnectRequired).toBe(true);
    });

    it('should return ready=false with reconnectRequired when contacts.readonly scope is missing', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord({
        scopes_granted: 'openid https://www.googleapis.com/auth/gmail.readonly',
      }));

      const result = await provider.canSync(TEST_USER_ID);

      expect(result.ready).toBe(false);
      expect(result.reconnectRequired).toBe(true);
      expect(result.error).toContain('Contacts permission not granted');
    });

    it('should attempt token refresh when token is expired', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord({
        token_expires_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      }));
      mockRefreshAccessToken.mockResolvedValue({ success: true });

      const result = await provider.canSync(TEST_USER_ID);

      expect(result.ready).toBe(true);
      expect(mockRefreshAccessToken).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('should return ready=false when token refresh fails', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord({
        token_expires_at: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      }));
      mockRefreshAccessToken.mockResolvedValue({ success: false, error: 'Refresh failed' });

      const result = await provider.canSync(TEST_USER_ID);

      expect(result.ready).toBe(false);
      expect(result.reconnectRequired).toBe(true);
      expect(result.error).toContain('Refresh failed');
    });

    it('should handle canSync throwing an error', async () => {
      mockGetOAuthToken.mockRejectedValue(new Error('Database error'));

      const result = await provider.canSync(TEST_USER_ID);

      expect(result.ready).toBe(false);
      expect(result.error).toContain('Database error');
    });
  });

  // ============================================
  // fetchContacts
  // ============================================

  describe('fetchContacts', () => {
    it('should fetch contacts from Google People API', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      mockConnectionsList.mockResolvedValue({
        data: {
          connections: [createMockPerson()],
          nextPageToken: undefined,
        },
      });

      const contacts = await provider.fetchContacts(TEST_USER_ID);

      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toEqual({
        external_record_id: 'people/c123456',
        name: 'John Doe',
        emails: ['john@example.com', 'johndoe@work.com'],
        phones: ['+15555550112'],
        company: 'Acme Corp',
      });
    });

    it('should handle pagination with nextPageToken', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      // First page
      mockConnectionsList.mockResolvedValueOnce({
        data: {
          connections: [createMockPerson({ resourceName: 'people/c1' })],
          nextPageToken: 'page2token',
        },
      });

      // Second page
      mockConnectionsList.mockResolvedValueOnce({
        data: {
          connections: [createMockPerson({ resourceName: 'people/c2' })],
          nextPageToken: undefined,
        },
      });

      const contacts = await provider.fetchContacts(TEST_USER_ID);

      expect(contacts).toHaveLength(2);
      expect(contacts[0].external_record_id).toBe('people/c1');
      expect(contacts[1].external_record_id).toBe('people/c2');
      expect(mockConnectionsList).toHaveBeenCalledTimes(2);
    });

    it('should map all person fields correctly', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      const person = createMockPerson({
        resourceName: 'people/c789',
        names: [
          { displayName: 'Jane Smith', metadata: { primary: true } },
          { displayName: 'J. Smith' },
        ],
        emailAddresses: [
          { value: 'jane@example.com' },
          { value: 'jane.smith@company.com' },
          { value: 'js@personal.com' },
        ],
        phoneNumbers: [
          { value: '+15555550121' },
          { value: '+15555550104' },
        ],
        organizations: [
          { name: 'Big Corp', metadata: { primary: true } },
          { name: 'Side Project LLC' },
        ],
      });

      mockConnectionsList.mockResolvedValue({
        data: {
          connections: [person],
          nextPageToken: undefined,
        },
      });

      const contacts = await provider.fetchContacts(TEST_USER_ID);

      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toEqual({
        external_record_id: 'people/c789',
        name: 'Jane Smith', // Primary name
        emails: ['jane@example.com', 'jane.smith@company.com', 'js@personal.com'],
        phones: ['+15555550121', '+15555550104'],
        company: 'Big Corp', // Primary org
      });
    });

    it('should handle contacts with missing fields', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      const minimalPerson = {
        resourceName: 'people/c999',
        // No names, emails, phones, or organizations
      };

      mockConnectionsList.mockResolvedValue({
        data: {
          connections: [minimalPerson],
          nextPageToken: undefined,
        },
      });

      const contacts = await provider.fetchContacts(TEST_USER_ID);

      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toEqual({
        external_record_id: 'people/c999',
        name: null,
        emails: [],
        phones: [],
        company: null,
      });
    });

    it('should skip contacts without resourceName', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      mockConnectionsList.mockResolvedValue({
        data: {
          connections: [
            createMockPerson({ resourceName: undefined }),
            createMockPerson({ resourceName: 'people/c456' }),
          ],
          nextPageToken: undefined,
        },
      });

      const contacts = await provider.fetchContacts(TEST_USER_ID);

      expect(contacts).toHaveLength(1);
      expect(contacts[0].external_record_id).toBe('people/c456');
    });

    it('should handle empty connections response', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      mockConnectionsList.mockResolvedValue({
        data: {
          connections: undefined,
          nextPageToken: undefined,
        },
      });

      const contacts = await provider.fetchContacts(TEST_USER_ID);

      expect(contacts).toHaveLength(0);
    });

    it('should throw when no token available', async () => {
      mockGetOAuthToken.mockResolvedValue(null);

      await expect(provider.fetchContacts(TEST_USER_ID)).rejects.toThrow(
        'No Google OAuth token available',
      );
    });

    it('should throw with reconnectRequired on 403 error', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      const error403 = new Error('Forbidden');
      (error403 as Error & { code?: number }).code = 403;
      mockConnectionsList.mockRejectedValue(error403);

      try {
        await provider.fetchContacts(TEST_USER_ID);
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('Access denied to Google contacts');
        expect((error as Error & { reconnectRequired?: boolean }).reconnectRequired).toBe(true);
      }
    });

    it('should throw and capture via Sentry on non-403 errors', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      const networkError = new Error('Network timeout');
      mockConnectionsList.mockRejectedValue(networkError);

      const Sentry = require('@sentry/electron/main');

      await expect(provider.fetchContacts(TEST_USER_ID)).rejects.toThrow('Network timeout');
      expect(Sentry.captureException).toHaveBeenCalledWith(networkError, {
        tags: { service: 'google-contacts', operation: 'fetchContacts' },
      });
    });

    it('should use fallback name when no primary name exists', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      const person = createMockPerson({
        names: [
          { displayName: 'Fallback Name' }, // No primary metadata
        ],
      });

      mockConnectionsList.mockResolvedValue({
        data: {
          connections: [person],
          nextPageToken: undefined,
        },
      });

      const contacts = await provider.fetchContacts(TEST_USER_ID);

      expect(contacts[0].name).toBe('Fallback Name');
    });

    it('should use fallback organization when no primary org exists', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      const person = createMockPerson({
        organizations: [
          { name: 'Fallback Org' }, // No primary metadata
        ],
      });

      mockConnectionsList.mockResolvedValue({
        data: {
          connections: [person],
          nextPageToken: undefined,
        },
      });

      const contacts = await provider.fetchContacts(TEST_USER_ID);

      expect(contacts[0].company).toBe('Fallback Org');
    });

    it('should pass correct parameters to People API', async () => {
      mockGetOAuthToken.mockResolvedValue(createMockTokenRecord());

      mockConnectionsList.mockResolvedValue({
        data: {
          connections: [],
          nextPageToken: undefined,
        },
      });

      await provider.fetchContacts(TEST_USER_ID);

      expect(mockConnectionsList).toHaveBeenCalledWith({
        resourceName: 'people/me',
        personFields: 'names,emailAddresses,phoneNumbers,organizations',
        pageSize: 1000,
        pageToken: undefined,
      });
    });
  });
});
