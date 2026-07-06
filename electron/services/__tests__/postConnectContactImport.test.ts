/**
 * Unit tests for postConnectContactImport (BACKLOG-1759)
 *
 * Validates the post-connect contact import trigger fired (fire-and-forget)
 * from the mailbox connection-completed handlers:
 * - enabled source + zero contacts        -> import invoked
 * - source already has contacts           -> skipped (idempotent)
 * - disabled source                       -> skipped
 * - import failure (throws / error result) -> resolves without throwing
 *   (the connect flow must never be affected)
 */

// Mock dependencies BEFORE importing the module under test.
// Variables are prefixed `mock` so babel-jest allows them inside factories.

jest.mock('../logService', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockGetContactSourceStats = jest.fn();
jest.mock('../db/externalContactDbService', () => ({
  getContactSourceStats: (...args: unknown[]) => mockGetContactSourceStats(...args),
}));

const mockIsContactSourceEnabled = jest.fn();
jest.mock('../../utils/preferenceHelper', () => ({
  isContactSourceEnabled: (...args: unknown[]) => mockIsContactSourceEnabled(...args),
}));

const mockGetProvider = jest.fn();
const mockSyncProvider = jest.fn();
jest.mock('../contactSyncService', () => ({
  __esModule: true,
  default: {
    getProvider: (...args: unknown[]) => mockGetProvider(...args),
    syncProvider: (...args: unknown[]) => mockSyncProvider(...args),
  },
}));

import { importEnabledEmptyContactSources } from '../postConnectContactImport';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

/** Provider stub — only preferenceKey/source are consumed by the module. */
function providerStub(source: string) {
  return { source, preferenceKey: `${source}Contacts` };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Defaults: provider registered, source enabled, no existing contacts, sync succeeds.
  mockGetProvider.mockImplementation((source: string) => providerStub(source));
  mockIsContactSourceEnabled.mockResolvedValue(true);
  mockGetContactSourceStats.mockReturnValue({ macos: 1055, iphone: 0, outlook: 0, google_contacts: 0, android_sync: 0 });
  mockSyncProvider.mockResolvedValue({ source: 'outlook', success: true, count: 42 });
});

describe('importEnabledEmptyContactSources', () => {
  it('invokes the import for an enabled source with zero contacts', async () => {
    const results = await importEnabledEmptyContactSources(TEST_USER_ID, ['outlook']);

    expect(mockSyncProvider).toHaveBeenCalledTimes(1);
    expect(mockSyncProvider).toHaveBeenCalledWith(TEST_USER_ID, 'outlook');
    expect(results).toEqual([
      expect.objectContaining({
        source: 'outlook',
        enabled: true,
        alreadyImported: false,
        imported: 42,
      }),
    ]);
  });

  it('checks the enabled state using the provider preferenceKey', async () => {
    await importEnabledEmptyContactSources(TEST_USER_ID, ['outlook']);

    expect(mockIsContactSourceEnabled).toHaveBeenCalledWith(
      TEST_USER_ID,
      'direct',
      'outlookContacts',
      true,
    );
  });

  it('skips a source that already has imported contacts (idempotent)', async () => {
    mockGetContactSourceStats.mockReturnValue({ macos: 0, iphone: 0, outlook: 128, google_contacts: 0, android_sync: 0 });

    const results = await importEnabledEmptyContactSources(TEST_USER_ID, ['outlook']);

    expect(mockSyncProvider).not.toHaveBeenCalled();
    expect(results[0]).toEqual(
      expect.objectContaining({ source: 'outlook', alreadyImported: true, imported: 0 }),
    );
  });

  it('skips a disabled source', async () => {
    mockIsContactSourceEnabled.mockResolvedValue(false);

    const results = await importEnabledEmptyContactSources(TEST_USER_ID, ['outlook']);

    expect(mockSyncProvider).not.toHaveBeenCalled();
    expect(results[0]).toEqual(
      expect.objectContaining({ source: 'outlook', enabled: false, imported: 0 }),
    );
  });

  it('skips when no provider is registered for the source', async () => {
    mockGetProvider.mockReturnValue(undefined);

    const results = await importEnabledEmptyContactSources(TEST_USER_ID, ['outlook']);

    expect(mockIsContactSourceEnabled).not.toHaveBeenCalled();
    expect(mockSyncProvider).not.toHaveBeenCalled();
    expect(results[0]).toEqual(
      expect.objectContaining({ source: 'outlook', enabled: false, imported: 0 }),
    );
  });

  it('does NOT throw when the import throws — the connect flow is unaffected', async () => {
    mockSyncProvider.mockRejectedValue(new Error('Graph API 500'));

    const results = await importEnabledEmptyContactSources(TEST_USER_ID, ['outlook']);

    expect(results[0]).toEqual(
      expect.objectContaining({ source: 'outlook', imported: 0, error: 'Graph API 500' }),
    );
  });

  it('propagates reconnectRequired without throwing when the provider needs scopes', async () => {
    mockSyncProvider.mockResolvedValue({
      source: 'google_contacts',
      success: false,
      count: 0,
      reconnectRequired: true,
      error: 'contacts.readonly scope missing',
    });

    const results = await importEnabledEmptyContactSources(TEST_USER_ID, ['google_contacts']);

    expect(results[0]).toEqual(
      expect.objectContaining({
        source: 'google_contacts',
        imported: 0,
        reconnectRequired: true,
        error: 'contacts.readonly scope missing',
      }),
    );
  });

  it('treats a stats read failure as empty and still triggers the import', async () => {
    mockGetContactSourceStats.mockImplementation(() => {
      throw new Error('DB locked');
    });

    const results = await importEnabledEmptyContactSources(TEST_USER_ID, ['outlook']);

    expect(mockSyncProvider).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(
      expect.objectContaining({ source: 'outlook', imported: 42 }),
    );
  });

  it('processes multiple sources independently (import one, skip the other)', async () => {
    mockGetContactSourceStats.mockReturnValue({ macos: 0, iphone: 0, outlook: 0, google_contacts: 5, android_sync: 0 });
    mockSyncProvider.mockResolvedValue({ source: 'outlook', success: true, count: 7 });

    const results = await importEnabledEmptyContactSources(TEST_USER_ID, ['outlook', 'google_contacts']);

    // outlook (empty) synced; google_contacts (5 existing) skipped
    expect(mockSyncProvider).toHaveBeenCalledTimes(1);
    expect(mockSyncProvider).toHaveBeenCalledWith(TEST_USER_ID, 'outlook');
    expect(results).toEqual([
      expect.objectContaining({ source: 'outlook', imported: 7, alreadyImported: false }),
      expect.objectContaining({ source: 'google_contacts', imported: 0, alreadyImported: true }),
    ]);
  });
});
