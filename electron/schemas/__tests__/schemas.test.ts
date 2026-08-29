/**
 * Tests for domain-specific Zod schemas.
 * Validates that schemas match the actual data shapes from the database.
 */
import { UserSchema, ContactSchema, TransactionSchema } from '../index';
import { safeValidate } from '../validate';

// Mock electron-log (required by validate.ts)
jest.mock('electron-log', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

describe('UserSchema', () => {
  const validUser = {
    id: 'abc-123-def',
    email: 'test@example.com',
    first_name: 'John',
    last_name: 'Doe',
    display_name: 'John Doe',
    avatar_url: null,
    oauth_provider: 'google' as const,
    oauth_id: 'google-123',
    subscription_tier: 'pro' as const,
    subscription_status: 'active' as const,
    trial_ends_at: null,
    is_active: 1, // SQLite returns number
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    last_login_at: '2024-06-01T12:00:00Z',
    timezone: 'America/Los_Angeles',
    theme: 'dark' as const,
    mobile_phone_type: 'iphone' as const,
    license_type: 'individual' as const,
    ai_detection_enabled: 0,
    organization_id: null,
  };

  it('validates a complete user object', () => {
    const result = safeValidate(UserSchema, validUser);
    expect(result.success).toBe(true);
  });

  it('validates user with SQLite boolean (0/1)', () => {
    const user = { ...validUser, is_active: 0 };
    const result = safeValidate(UserSchema, user);
    expect(result.success).toBe(true);
  });

  it('validates user with JS boolean', () => {
    const user = { ...validUser, is_active: true };
    const result = safeValidate(UserSchema, user);
    expect(result.success).toBe(true);
  });

  it('validates user with nullable optional fields', () => {
    const user = {
      ...validUser,
      first_name: undefined,
      last_name: undefined,
      display_name: undefined,
      avatar_url: undefined,
      trial_ends_at: undefined,
      timezone: null,
      theme: null,
      notification_preferences: null,
    };
    const result = safeValidate(UserSchema, user);
    expect(result.success).toBe(true);
  });

  it('rejects user with invalid oauth_provider', () => {
    const user = { ...validUser, oauth_provider: 'facebook' };
    const result = safeValidate(UserSchema, user);
    expect(result.success).toBe(false);
  });

  it('validates user with azure provider (accepted by type system)', () => {
    const user = { ...validUser, oauth_provider: 'azure' };
    const result = safeValidate(UserSchema, user);
    expect(result.success).toBe(true);
  });
});

describe('ContactSchema', () => {
  const validContact = {
    id: 'contact-123',
    user_id: 'user-456',
    display_name: 'Jane Smith',
    company: 'Acme Corp',
    title: 'Agent',
    source: 'manual' as const,
    last_inbound_at: null,
    last_outbound_at: null,
    total_messages: 42,
    tags: '["VIP","past_client"]',
    metadata: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    is_message_derived: 0,
    last_communication_at: null,
    allEmails: ['jane@acme.com'],
    allPhones: ['+14155550001'],
    name: 'Jane Smith',
    email: 'jane@acme.com',
    phone: '+14155550001',
  };

  it('validates a complete contact object', () => {
    const result = safeValidate(ContactSchema, validContact);
    expect(result.success).toBe(true);
  });

  it('validates contact with all sources', () => {
    const sources = ['manual', 'email', 'sms', 'messages', 'contacts_app', 'inferred', 'outlook'];
    for (const source of sources) {
      const contact = { ...validContact, source };
      const result = safeValidate(ContactSchema, contact);
      expect(result.success).toBe(true);
    }
  });

  it('validates contact without optional array fields', () => {
    const { allEmails, allPhones, ...minimal } = validContact;
    const result = safeValidate(ContactSchema, minimal);
    expect(result.success).toBe(true);
  });

  it('rejects contact with invalid source', () => {
    const contact = { ...validContact, source: 'unknown_source' };
    const result = safeValidate(ContactSchema, contact);
    expect(result.success).toBe(false);
  });
});

describe('TransactionSchema', () => {
  const validTransaction = {
    id: 'txn-123',
    user_id: 'user-456',
    property_address: '123 Main St, Seattle WA 98101',
    property_street: '123 Main St',
    property_city: 'Seattle',
    property_state: 'WA',
    property_zip: '98101',
    property_coordinates: null,
    transaction_type: 'purchase' as const,
    status: 'active' as const,
    started_at: '2024-01-15T00:00:00Z',
    closed_at: null,
    last_activity_at: '2024-06-01T00:00:00Z',
    confidence_score: 0.95,
    stage: 'escrow' as const,
    stage_source: null,
    stage_confidence: null,
    stage_updated_at: null,
    listing_price: 750000,
    sale_price: null,
    earnest_money_amount: null,
    mutual_acceptance_date: null,
    inspection_deadline: null,
    financing_deadline: null,
    closing_deadline: '2024-07-15T00:00:00Z',
    message_count: 150,
    attachment_count: 25,
    text_thread_count: 3,
    email_count: 100,
    // BACKLOG-2559: `text_count` was removed from TransactionSchema — it is
    // neither a `transactions` column nor computed on any read path, so it
    // could never carry a value. Note that leaving it in this fixture would
    // NOT have failed anything: a plain z.object strips unknown keys, so the
    // stale key would have been deleted in silence and this suite would have
    // stayed green. The column set is enforced by
    // electron/schemas/__tests__/transactionSchemaParity.test.ts, which runs
    // the real migration chain and compares exact sets.
    export_status: 'not_exported' as const,
    export_count: 0,
    last_exported_at: null,
    metadata: null,
    created_at: '2024-01-15T00:00:00Z',
    updated_at: '2024-06-01T00:00:00Z',
    detection_source: 'manual' as const,
    detection_status: null,
    detection_confidence: null,
    detection_method: null,
    suggested_contacts: null,
    reviewed_at: null,
    rejection_reason: null,
  };

  it('validates a complete transaction object', () => {
    const result = safeValidate(TransactionSchema, validTransaction);
    expect(result.success).toBe(true);
  });

  it('validates all transaction statuses', () => {
    const statuses = ['pending', 'active', 'closed', 'rejected'];
    for (const status of statuses) {
      const txn = { ...validTransaction, status };
      const result = safeValidate(TransactionSchema, txn);
      expect(result.success).toBe(true);
    }
  });

  it('validates all transaction stages', () => {
    const stages = ['intro', 'showing', 'offer', 'inspections', 'escrow', 'closing', 'post_closing'];
    for (const stage of stages) {
      const txn = { ...validTransaction, stage };
      const result = safeValidate(TransactionSchema, txn);
      expect(result.success).toBe(true);
    }
  });

  it('validates transaction with minimal required fields', () => {
    const minimal = {
      id: 'txn-min',
      user_id: 'user-1',
      property_address: '456 Oak Ave',
      status: 'pending' as const,
      message_count: 0,
      attachment_count: 0,
      export_status: 'not_exported' as const,
      export_count: 0,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };
    const result = safeValidate(TransactionSchema, minimal);
    expect(result.success).toBe(true);
  });

  it('rejects transaction with invalid status', () => {
    const txn = { ...validTransaction, status: 'unknown' };
    const result = safeValidate(TransactionSchema, txn);
    expect(result.success).toBe(false);
  });
});
