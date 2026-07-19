/**
 * Unit tests for ContactSyncService (TASK-2300)
 *
 * Tests the shared contact sync orchestrator including:
 * - Provider registration
 * - syncAll with mock providers
 * - syncProvider with unknown source
 * - canSync returning { ready: false } skips sync
 * - Preference-gated sync (disabled source)
 * - Error isolation between providers
 */

// Mock dependencies BEFORE importing the module under test

jest.mock('../services/logService', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../services/db/externalContactDbService', () => ({
  syncContactsBySource: jest.fn().mockReturnValue({
    inserted: 3,
    updated: 0,
    deleted: 1,
    total: 5,
  }),
  // Keep syncOutlookContacts mock for backward compat tests
  syncOutlookContacts: jest.fn().mockReturnValue({
    inserted: 3,
    updated: 0,
    deleted: 1,
    total: 5,
  }),
}));

const mockIsContactSourceEnabled = jest.fn().mockResolvedValue(true);
jest.mock('../utils/preferenceHelper', () => ({
  isContactSourceEnabled: (...args: unknown[]) => mockIsContactSourceEnabled(...args),
}));

import {
  ContactSyncService,
  ContactSyncProvider,
  ExternalContactRecord,
  CanSyncResult,
} from '../services/contactSyncService';
import * as externalContactDb from '../services/db/externalContactDbService';

// ============================================
// TEST HELPERS
// ============================================

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

/**
 * Create a mock ContactSyncProvider for testing
 */
function createMockProvider(overrides: Partial<ContactSyncProvider> & { source: string }): ContactSyncProvider {
  return {
    preferenceKey: `${overrides.source}Contacts`,
    canSync: jest.fn().mockResolvedValue({ ready: true }),
    fetchContacts: jest.fn().mockResolvedValue([
      {
        external_record_id: 'record-1',
        name: 'Test Contact',
        emails: ['test@example.com'],
        phones: ['+1234567890'],
        company: 'Test Corp',
      },
    ] as ExternalContactRecord[]),
    ...overrides,
  };
}

// ============================================
// TESTS
// ============================================

describe('ContactSyncService', () => {
  let service: ContactSyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsContactSourceEnabled.mockResolvedValue(true);
    service = new ContactSyncService();
  });

  // ============================================
  // Provider Registration
  // ============================================

  describe('registerProvider', () => {
    it('should register a provider by source name', () => {
      const provider = createMockProvider({ source: 'outlook' });
      service.registerProvider(provider);

      expect(service.getProvider('outlook')).toBe(provider);
      expect(service.getRegisteredSources()).toContain('outlook');
    });

    it('should replace a provider if registered with the same source', () => {
      const provider1 = createMockProvider({ source: 'outlook' });
      const provider2 = createMockProvider({ source: 'outlook' });

      service.registerProvider(provider1);
      service.registerProvider(provider2);

      expect(service.getProvider('outlook')).toBe(provider2);
      expect(service.getRegisteredSources()).toEqual(['outlook']);
    });

    it('should support multiple providers', () => {
      const outlook = createMockProvider({ source: 'outlook' });
      const google = createMockProvider({ source: 'google' });

      service.registerProvider(outlook);
      service.registerProvider(google);

      expect(service.getRegisteredSources()).toEqual(['outlook', 'google']);
    });
  });

  // ============================================
  // syncAll
  // ============================================

  describe('syncAll', () => {
    it('should sync all registered providers', async () => {
      const outlook = createMockProvider({ source: 'outlook' });
      const google = createMockProvider({ source: 'google' });

      service.registerProvider(outlook);
      service.registerProvider(google);

      const results = await service.syncAll(TEST_USER_ID);

      expect(results).toHaveLength(2);
      expect(results[0].source).toBe('outlook');
      expect(results[0].success).toBe(true);
      expect(results[1].source).toBe('google');
      expect(results[1].success).toBe(true);

      expect(outlook.canSync).toHaveBeenCalledWith(TEST_USER_ID);
      expect(outlook.fetchContacts).toHaveBeenCalledWith(TEST_USER_ID);
      expect(google.canSync).toHaveBeenCalledWith(TEST_USER_ID);
      expect(google.fetchContacts).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('should return empty array when no providers registered', async () => {
      const results = await service.syncAll(TEST_USER_ID);
      expect(results).toEqual([]);
    });

    it('should isolate errors between providers', async () => {
      const failingProvider = createMockProvider({
        source: 'outlook',
        fetchContacts: jest.fn().mockRejectedValue(new Error('API error')),
      });
      const workingProvider = createMockProvider({ source: 'google' });

      service.registerProvider(failingProvider);
      service.registerProvider(workingProvider);

      const results = await service.syncAll(TEST_USER_ID);

      expect(results).toHaveLength(2);
      // First provider failed
      expect(results[0].source).toBe('outlook');
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('API error');
      // Second provider succeeded
      expect(results[1].source).toBe('google');
      expect(results[1].success).toBe(true);
    });

    it('should store fetched contacts via externalContactDbService', async () => {
      const contacts: ExternalContactRecord[] = [
        {
          external_record_id: 'rec-1',
          name: 'John Doe',
          emails: ['john@example.com'],
          phones: ['+1555123456'],
          company: 'Acme Corp',
        },
        {
          external_record_id: 'rec-2',
          name: 'Jane Smith',
          emails: ['jane@example.com'],
          phones: [],
          company: null,
        },
      ];

      const provider = createMockProvider({
        source: 'outlook',
        fetchContacts: jest.fn().mockResolvedValue(contacts),
      });

      service.registerProvider(provider);
      await service.syncAll(TEST_USER_ID);

      expect(externalContactDb.syncContactsBySource).toHaveBeenCalledWith(
        TEST_USER_ID,
        'outlook',
        contacts.map((c) => ({
          external_record_id: c.external_record_id,
          name: c.name,
          emails: c.emails,
          phones: c.phones,
          company: c.company,
        })),
      );
    });
  });

  // ============================================
  // syncProvider
  // ============================================

  describe('syncProvider', () => {
    it('should sync a specific provider by source name', async () => {
      const provider = createMockProvider({ source: 'outlook' });
      service.registerProvider(provider);

      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(result.source).toBe('outlook');
      expect(result.success).toBe(true);
      expect(result.count).toBe(3); // From mock syncContactsBySource
      expect(provider.fetchContacts).toHaveBeenCalledWith(TEST_USER_ID);
    });

    it('should return error for unknown source', async () => {
      const result = await service.syncProvider(TEST_USER_ID, 'unknown-source');

      expect(result.success).toBe(false);
      expect(result.source).toBe('unknown-source');
      expect(result.error).toContain('No provider registered for source: unknown-source');
      expect(result.count).toBe(0);
    });

    it('should not call canSync for unknown source', async () => {
      const provider = createMockProvider({ source: 'outlook' });
      service.registerProvider(provider);

      await service.syncProvider(TEST_USER_ID, 'nonexistent');

      expect(provider.canSync).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // canSync handling
  // ============================================

  describe('canSync behavior', () => {
    it('should skip sync when canSync returns { ready: false }', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        canSync: jest.fn().mockResolvedValue({
          ready: false,
          error: 'No token available',
        } as CanSyncResult),
      });

      service.registerProvider(provider);
      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(result.success).toBe(false);
      expect(result.error).toBe('No token available');
      expect(provider.fetchContacts).not.toHaveBeenCalled();
    });

    it('should pass through reconnectRequired from canSync', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        canSync: jest.fn().mockResolvedValue({
          ready: false,
          reconnectRequired: true,
          error: 'Please reconnect',
        } as CanSyncResult),
      });

      service.registerProvider(provider);
      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(result.success).toBe(false);
      expect(result.reconnectRequired).toBe(true);
      expect(provider.fetchContacts).not.toHaveBeenCalled();
    });

    it('should proceed with sync when canSync returns { ready: true }', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        canSync: jest.fn().mockResolvedValue({ ready: true }),
      });

      service.registerProvider(provider);
      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(result.success).toBe(true);
      expect(provider.fetchContacts).toHaveBeenCalledWith(TEST_USER_ID);
    });
  });

  // ============================================
  // Preference gating
  // ============================================

  describe('preference gating', () => {
    it('should skip sync when source is disabled in preferences', async () => {
      mockIsContactSourceEnabled.mockResolvedValue(false);

      const provider = createMockProvider({ source: 'outlook' });
      service.registerProvider(provider);

      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(provider.canSync).not.toHaveBeenCalled();
      expect(provider.fetchContacts).not.toHaveBeenCalled();
    });

    it('should check preferences with correct key', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        preferenceKey: 'outlookContacts',
      });

      service.registerProvider(provider);
      await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(mockIsContactSourceEnabled).toHaveBeenCalledWith(
        TEST_USER_ID,
        'direct',
        'outlookContacts',
        true,
      );
    });
  });

  // ============================================
  // Error handling
  // ============================================

  describe('error handling', () => {
    it('should handle fetchContacts throwing an error', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        fetchContacts: jest.fn().mockRejectedValue(new Error('Network timeout')),
      });

      service.registerProvider(provider);
      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      // syncProvider wraps in _syncSingleProvider which lets the error propagate
      // but syncAll catches it
      expect(result.success).toBe(false);
      expect(result.error).toContain('Network timeout');
    });

    it('should handle canSync throwing an error', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        canSync: jest.fn().mockRejectedValue(new Error('Token check failed')),
      });

      service.registerProvider(provider);

      // syncProvider doesn't catch — let's test via syncAll which does
      const results = await service.syncAll(TEST_USER_ID);

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Token check failed');
    });
  });

  // ============================================
  // BACKLOG-2142: dead-token classification
  // A dead/expired OAuth token during contacts sync must be classified with a
  // typed `tokenExpired` discriminator (not swallowed as a generic error), so
  // the renderer can surface a provider-aware reconnect CTA.
  // ============================================

  describe('dead-token classification (BACKLOG-2142)', () => {
    it('sets tokenExpired:true when fetchContacts throws an expired-token error (via syncProvider)', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        fetchContacts: jest
          .fn()
          .mockRejectedValue(new Error('InvalidAuthenticationToken: token expired')),
      });

      service.registerProvider(provider);
      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(result.success).toBe(false);
      expect(result.tokenExpired).toBe(true);
      expect(result.error).toContain('token expired');
    });

    it('sets tokenExpired:true for a 401 error (via syncAll) and isolates it from a working provider', async () => {
      const authFailure = Object.assign(new Error('Unauthorized'), {
        response: { status: 401 },
      });
      const failing = createMockProvider({
        source: 'outlook',
        fetchContacts: jest.fn().mockRejectedValue(authFailure),
      });
      const working = createMockProvider({ source: 'google' });

      service.registerProvider(failing);
      service.registerProvider(working);

      const results = await service.syncAll(TEST_USER_ID);

      expect(results).toHaveLength(2);
      expect(results[0].source).toBe('outlook');
      expect(results[0].success).toBe(false);
      expect(results[0].tokenExpired).toBe(true);
      // Working provider unaffected and NOT flagged as a token failure.
      expect(results[1].source).toBe('google');
      expect(results[1].success).toBe(true);
      expect(results[1].tokenExpired).toBeUndefined();
    });

    it('does NOT set tokenExpired for a non-auth (transient) error — no false positive', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        fetchContacts: jest.fn().mockRejectedValue(new Error('network timeout')),
      });

      service.registerProvider(provider);
      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(result.success).toBe(false);
      // Catch path returns the explicit boolean from the classifier — false, not
      // token-expired. Downstream (orchestrator) only reconnects on `true`.
      expect(result.tokenExpired).toBe(false);
    });

    it('classifies a not-ready canSync whose error reads as a dead token as tokenExpired', async () => {
      const provider = createMockProvider({
        source: 'outlook',
        canSync: jest.fn().mockResolvedValue({
          ready: false,
          reconnectRequired: true,
          error: 'Token refresh failed',
        } as CanSyncResult),
      });

      service.registerProvider(provider);
      const result = await service.syncProvider(TEST_USER_ID, 'outlook');

      expect(result.success).toBe(false);
      expect(result.reconnectRequired).toBe(true);
      expect(result.tokenExpired).toBe(true);
      expect(provider.fetchContacts).not.toHaveBeenCalled();
    });

    it('does NOT flag a scope-only not-ready canSync (no token-expiry wording) as tokenExpired', async () => {
      const provider = createMockProvider({
        source: 'google',
        canSync: jest.fn().mockResolvedValue({
          ready: false,
          reconnectRequired: true,
          // Scope-missing wording that deliberately avoids every token-expiry
          // pattern (no "reconnect"/"token expired"/"invalid_grant"/401), so the
          // classifier leaves tokenExpired unset. reconnectRequired still flows.
          error: 'Contacts permission not granted. Grant contact access in Settings.',
        } as CanSyncResult),
      });

      service.registerProvider(provider);
      const result = await service.syncProvider(TEST_USER_ID, 'google');

      expect(result.success).toBe(false);
      expect(result.reconnectRequired).toBe(true);
      expect(result.tokenExpired).toBeUndefined();
    });
  });
});
