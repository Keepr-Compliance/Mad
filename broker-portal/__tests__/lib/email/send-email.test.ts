/**
 * Tests for the email service module.
 *
 * Tests cover:
 * - sendEmail success path (mocked Graph client)
 * - sendEmail error handling (Graph API error, unexpected error)
 * - sendEmail with missing Azure credentials
 * - sendEmail with missing EMAIL_SENDER_ADDRESS
 * - Template generation (invite, ticket reply, ticket assignment)
 * - Plain-text fallbacks
 *
 * TASK-2197: Email Service Infrastructure
 */

/* eslint-disable @typescript-eslint/no-require-imports */

// ---------------------------------------------------------------------------
// Mock setup -- must be before imports
// ---------------------------------------------------------------------------

const mockPost = jest.fn();
const mockApi = jest.fn(() => ({ post: mockPost }));

jest.mock('@azure/identity', () => ({
  ClientSecretCredential: jest.fn(),
}));

jest.mock('@microsoft/microsoft-graph-client', () => ({
  Client: {
    initWithMiddleware: jest.fn(() => ({
      api: mockApi,
    })),
  },
}));

jest.mock(
  '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials',
  () => ({
    TokenCredentialAuthenticationProvider: jest.fn(),
  }),
);

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { sendEmail } from '../../../lib/email/send-email';
import { resetGraphClient } from '../../../lib/email/graph-client';
import { buildInviteEmail } from '../../../lib/email/templates/invite';
import { buildTicketReplyNotification } from '../../../lib/email/templates/ticket-reply-notification';
import { buildTicketAssignmentNotification } from '../../../lib/email/templates/ticket-assignment-notification';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = process.env;

function setEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env = {
    ...ORIGINAL_ENV,
    AZURE_TENANT_ID: 'test-tenant',
    AZURE_CLIENT_ID: 'test-client',
    AZURE_CLIENT_SECRET: 'test-secret',
    EMAIL_SENDER_ADDRESS: 'noreply@test.com',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sendEmail tests
// ---------------------------------------------------------------------------

describe('sendEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetGraphClient();
    setEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('should send email successfully via Graph API', async () => {
    mockPost.mockResolvedValueOnce(undefined); // 202 no body

    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test Subject',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    expect(result).toEqual({ success: true, outcome: 'sent' });
    expect(mockApi).toHaveBeenCalledWith('/users/noreply@test.com/sendMail');
    expect(mockPost).toHaveBeenCalledWith({
      message: {
        subject: 'Test Subject',
        body: {
          contentType: 'HTML',
          content: '<p>Hello</p>',
        },
        toRecipients: [{ emailAddress: { address: 'user@example.com' } }],
        internetMessageHeaders: [
          {
            name: 'X-List-Unsubscribe',
            value: '<mailto:unsubscribe@keeprcompliance.com>',
          },
        ],
      },
    });
  });

  it('should send to multiple recipients', async () => {
    mockPost.mockResolvedValueOnce(undefined);

    const result = await sendEmail({
      to: ['a@example.com', 'b@example.com'],
      subject: 'Multi',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(result.success).toBe(true);
    expect(mockPost).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          toRecipients: [
            { emailAddress: { address: 'a@example.com' } },
            { emailAddress: { address: 'b@example.com' } },
          ],
        }),
      }),
    );
  });

  it('should include replyTo when provided', async () => {
    mockPost.mockResolvedValueOnce(undefined);

    await sendEmail({
      to: 'user@example.com',
      subject: 'With Reply-To',
      html: '<p>Hi</p>',
      text: 'Hi',
      replyTo: 'support@example.com',
    });

    expect(mockPost).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          replyTo: [{ emailAddress: { address: 'support@example.com' } }],
        }),
      }),
    );
  });

  it('should use custom from address when provided', async () => {
    mockPost.mockResolvedValueOnce(undefined);

    await sendEmail({
      to: 'user@example.com',
      subject: 'Custom From',
      html: '<p>Hi</p>',
      text: 'Hi',
      from: 'custom@example.com',
    });

    expect(mockApi).toHaveBeenCalledWith('/users/custom@example.com/sendMail');
  });

  it('should return error when Azure credentials are missing', async () => {
    resetGraphClient();
    setEnv({
      AZURE_TENANT_ID: undefined,
      AZURE_CLIENT_ID: undefined,
      AZURE_CLIENT_SECRET: undefined,
    });

    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(result).toEqual({
      success: false,
      error: 'Email service not configured (missing Azure credentials)',
      outcome: 'skipped',
    });
  });

  it('should return error when EMAIL_SENDER_ADDRESS is missing', async () => {
    resetGraphClient();
    setEnv({ EMAIL_SENDER_ADDRESS: undefined });

    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(result).toEqual({
      success: false,
      error: 'Email service not configured (missing EMAIL_SENDER_ADDRESS)',
      outcome: 'skipped',
    });
  });

  it('should handle a permanent Graph API error gracefully (no retry, outcome failed)', async () => {
    // BACKLOG-2009: a 4xx (permanent) error is not retried and not queued.
    const err = new Error('403 Forbidden') as Error & { statusCode: number };
    err.statusCode = 403;
    mockPost.mockRejectedValueOnce(err);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(result).toEqual({
      success: false,
      error: '403 Forbidden',
      outcome: 'failed',
    });
    expect(mockPost).toHaveBeenCalledTimes(1); // permanent -> no retry
    expect(consoleSpy).toHaveBeenCalledWith(
      '[Email] Graph API error sending email:',
      '403 Forbidden',
    );

    consoleSpy.mockRestore();
  });

  it('should handle non-Error exceptions gracefully (permanent status)', async () => {
    // A non-Error rejection with a permanent status resolves to "Unknown email error".
    mockPost.mockRejectedValueOnce({ statusCode: 400, body: 'string error' });

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const result = await sendEmail({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    expect(result).toEqual({
      success: false,
      error: 'Unknown email error',
      outcome: 'failed',
    });

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Template tests
// ---------------------------------------------------------------------------

describe('buildInviteEmail', () => {
  const params = {
    recipientEmail: 'new@example.com',
    organizationName: 'Acme Corp',
    inviterName: 'Jane Smith',
    role: 'Admin',
    inviteLink: 'https://app.keepr.com/invite/abc123',
    expiresInDays: 7,
  };

  it('should generate subject with organisation name', () => {
    const result = buildInviteEmail(params);
    expect(result.subject).toContain('Acme Corp');
    expect(result.subject).toContain('Keepr');
  });

  it('should generate HTML with all required params', () => {
    const result = buildInviteEmail(params);
    expect(result.html).toContain('Acme Corp');
    expect(result.html).toContain('Admin');
    expect(result.html).toContain('https://app.keepr.com/invite/abc123');
    expect(result.html).toContain('7 days');
    expect(result.html).toContain('Accept Invitation');
  });

  it('should generate valid HTML structure', () => {
    const result = buildInviteEmail(params);
    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('<html');
    expect(result.html).toContain('</html>');
    expect(result.html).toContain('Keepr');
  });

  it('should use inline CSS (no style tags)', () => {
    const result = buildInviteEmail(params);
    expect(result.html).not.toMatch(/<style[\s>]/);
  });

  it('should generate plain-text fallback with essential content', () => {
    const result = buildInviteEmail(params);
    expect(result.text).toContain('Acme Corp');
    expect(result.text).toContain('Admin');
    expect(result.text).toContain('https://app.keepr.com/invite/abc123');
    expect(result.text).toContain('7 days');
  });

  it('should handle singular day', () => {
    const result = buildInviteEmail({ ...params, expiresInDays: 1 });
    expect(result.html).toContain('1 day.');
    expect(result.text).toContain('1 day.');
  });

  it('should escape HTML in user-provided content', () => {
    const result = buildInviteEmail({
      ...params,
      organizationName: '<script>alert("xss")</script>',
    });
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
  });
});

describe('buildTicketReplyNotification', () => {
  const params = {
    recipientEmail: 'customer@example.com',
    ticketSubject: 'Help with login',
    ticketNumber: 'TKT-0042',
    agentName: 'Support Team',
    replyPreview: 'Thank you for reaching out. We have looked into your issue and...',
    ticketLink: 'https://portal.keepr.com/support/TKT-0042',
  };

  it('should generate subject with ticket number', () => {
    const result = buildTicketReplyNotification(params);
    expect(result.subject).toContain('TKT-0042');
    expect(result.subject).toContain('Help with login');
  });

  it('should generate HTML with all required params', () => {
    const result = buildTicketReplyNotification(params);
    expect(result.html).toContain('TKT-0042');
    expect(result.html).toContain('Help with login');
    expect(result.html).toContain('Support Team');
    expect(result.html).toContain('Thank you for reaching out');
    expect(result.html).toContain('https://portal.keepr.com/support/TKT-0042');
    expect(result.html).toContain('View Full Conversation');
  });

  it('should truncate long reply previews to 200 characters', () => {
    const longPreview = 'A'.repeat(250);
    const result = buildTicketReplyNotification({
      ...params,
      replyPreview: longPreview,
    });
    // Should contain 200 A's followed by ...
    expect(result.html).toContain('A'.repeat(200) + '...');
    expect(result.html).not.toContain('A'.repeat(201));
  });

  it('should use inline CSS (no style tags)', () => {
    const result = buildTicketReplyNotification(params);
    expect(result.html).not.toMatch(/<style[\s>]/);
  });

  it('should generate plain-text fallback with essential content', () => {
    const result = buildTicketReplyNotification(params);
    expect(result.text).toContain('TKT-0042');
    expect(result.text).toContain('Help with login');
    expect(result.text).toContain('Support Team');
    expect(result.text).toContain('Thank you for reaching out');
    expect(result.text).toContain('https://portal.keepr.com/support/TKT-0042');
  });
});

describe('buildTicketAssignmentNotification', () => {
  const params = {
    recipientEmail: 'agent@company.com',
    ticketSubject: 'Billing inquiry',
    ticketNumber: 'TKT-0099',
    customerName: 'John Doe',
    priority: 'High',
    ticketLink: 'https://admin.keepr.com/support/TKT-0099',
  };

  it('should generate subject with ticket number', () => {
    const result = buildTicketAssignmentNotification(params);
    expect(result.subject).toContain('TKT-0099');
    expect(result.subject).toContain('Billing inquiry');
  });

  it('should generate HTML with all required params', () => {
    const result = buildTicketAssignmentNotification(params);
    expect(result.html).toContain('TKT-0099');
    expect(result.html).toContain('Billing inquiry');
    expect(result.html).toContain('John Doe');
    expect(result.html).toContain('High');
    expect(result.html).toContain('https://admin.keepr.com/support/TKT-0099');
    expect(result.html).toContain('View Ticket');
  });

  it('should use appropriate priority colors', () => {
    // High priority should use orange
    const high = buildTicketAssignmentNotification(params);
    expect(high.html).toContain('#ea580c');

    // Urgent priority should use red
    const urgent = buildTicketAssignmentNotification({
      ...params,
      priority: 'urgent',
    });
    expect(urgent.html).toContain('#dc2626');

    // Low priority should use green
    const low = buildTicketAssignmentNotification({
      ...params,
      priority: 'Low',
    });
    expect(low.html).toContain('#16a34a');
  });

  it('should use inline CSS (no style tags)', () => {
    const result = buildTicketAssignmentNotification(params);
    expect(result.html).not.toMatch(/<style[\s>]/);
  });

  it('should generate plain-text fallback with essential content', () => {
    const result = buildTicketAssignmentNotification(params);
    expect(result.text).toContain('TKT-0099');
    expect(result.text).toContain('Billing inquiry');
    expect(result.text).toContain('John Doe');
    expect(result.text).toContain('High');
    expect(result.text).toContain('https://admin.keepr.com/support/TKT-0099');
  });
});
