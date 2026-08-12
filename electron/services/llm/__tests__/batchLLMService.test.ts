import {
  createBatches,
  estimateEmailTokens,
  formatBatchPrompt,
  extractJsonArray,
  parseBatchResponse,
  processBatchErrors,
  DEFAULT_BATCH_CONFIG,
  EmailBatch,
} from '../batchLLMService';
import type { MessageInput } from '../../extraction/types';

// Helper to create test emails
function createEmail(overrides: Partial<MessageInput> = {}): MessageInput {
  return {
    id: 'test-id',
    subject: 'Test Subject',
    body: 'Test body content',
    sender: 'sender@example.com',
    recipients: ['recipient@example.com'],
    date: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('batchLLMService', () => {
  describe('estimateEmailTokens', () => {
    it('should estimate tokens based on content length', () => {
      const email = createEmail({
        subject: 'Test', // 4 chars
        body: 'x'.repeat(300), // 300 chars
      });

      const tokens = estimateEmailTokens(email);

      // With metadata (~50 chars) and 3:1 ratio, expect ~120 tokens
      expect(tokens).toBeGreaterThan(100);
      expect(tokens).toBeLessThan(200);
    });

    it('should handle empty subject and body', () => {
      const email = createEmail({
        subject: '',
        body: '',
      });

      const tokens = estimateEmailTokens(email);

      // Should still count metadata
      expect(tokens).toBeGreaterThan(0);
    });

    it('should truncate long bodies to 2000 chars', () => {
      const shortEmail = createEmail({ body: 'x'.repeat(1000) });
      const longEmail = createEmail({ body: 'x'.repeat(10000) });

      const shortTokens = estimateEmailTokens(shortEmail);
      const longTokens = estimateEmailTokens(longEmail);

      // Long email should be truncated, so difference should be limited
      expect(longTokens - shortTokens).toBeLessThan(500);
    });
  });

  describe('createBatches', () => {
    it('should create batches within token limits', () => {
      const emails = Array(50)
        .fill(null)
        .map((_, i) =>
          createEmail({
            id: `email_${i}`,
            body: 'x'.repeat(1000), // ~333 tokens each
          })
        );

      const result = createBatches(emails, {
        maxTokensPerBatch: 5000,
        maxEmailsPerBatch: 30,
        avgTokensPerEmail: 333,
      });

      expect(result.batches.length).toBeGreaterThan(1);
      result.batches.forEach((batch) => {
        expect(batch.estimatedTokens).toBeLessThanOrEqual(5000);
      });
    });

    it('should respect max emails per batch', () => {
      const emails = Array(100)
        .fill(null)
        .map((_, i) =>
          createEmail({
            id: `email_${i}`,
            body: 'Short',
          })
        );

      const result = createBatches(emails, {
        maxTokensPerBatch: 100000,
        maxEmailsPerBatch: 30,
        avgTokensPerEmail: 10,
      });

      result.batches.forEach((batch) => {
        expect(batch.emails.length).toBeLessThanOrEqual(30);
      });
    });

    it('should handle empty email array', () => {
      const result = createBatches([]);

      expect(result.batches).toEqual([]);
      expect(result.stats.totalEmails).toBe(0);
      expect(result.stats.totalBatches).toBe(0);
      expect(result.stats.avgEmailsPerBatch).toBe(0);
      expect(result.stats.estimatedTotalTokens).toBe(0);
    });

    it('should create single batch for small email list', () => {
      const emails = Array(5)
        .fill(null)
        .map((_, i) => createEmail({ id: `email_${i}` }));

      const result = createBatches(emails);

      expect(result.batches.length).toBe(1);
      expect(result.batches[0].emails.length).toBe(5);
    });

    it('should calculate correct stats', () => {
      const emails = Array(45)
        .fill(null)
        .map((_, i) => createEmail({ id: `email_${i}` }));

      const result = createBatches(emails, {
        ...DEFAULT_BATCH_CONFIG,
        maxEmailsPerBatch: 20,
      });

      expect(result.stats.totalEmails).toBe(45);
      expect(result.stats.totalBatches).toBe(3); // 20 + 20 + 5
      expect(result.stats.avgEmailsPerBatch).toBe(15); // 45 / 3
    });

    it('should assign unique batch IDs', () => {
      const emails = Array(60)
        .fill(null)
        .map((_, i) => createEmail({ id: `email_${i}` }));

      const result = createBatches(emails, {
        ...DEFAULT_BATCH_CONFIG,
        maxEmailsPerBatch: 20,
      });

      const batchIds = result.batches.map((b) => b.batchId);
      const uniqueIds = new Set(batchIds);

      expect(uniqueIds.size).toBe(batchIds.length);
    });

    it('should preserve email order within batches', () => {
      const emails = Array(10)
        .fill(null)
        .map((_, i) => createEmail({ id: `email_${i}` }));

      const result = createBatches(emails, {
        ...DEFAULT_BATCH_CONFIG,
        maxEmailsPerBatch: 5,
      });

      expect(result.batches[0].emails.map((e) => e.id)).toEqual([
        'email_0',
        'email_1',
        'email_2',
        'email_3',
        'email_4',
      ]);
      expect(result.batches[1].emails.map((e) => e.id)).toEqual([
        'email_5',
        'email_6',
        'email_7',
        'email_8',
        'email_9',
      ]);
    });
  });

  describe('formatBatchPrompt', () => {
    it('should format batch with all email details', () => {
      const batch = {
        batchId: 'test-batch',
        emails: [
          createEmail({
            id: 'email-1',
            subject: 'Property at 123 Main St',
            sender: 'agent@realty.com',
            recipients: ['client@email.com'],
            date: '2024-01-15T10:00:00Z',
            body: 'Interested in this property?',
          }),
        ],
        estimatedTokens: 100,
      };

      const prompt = formatBatchPrompt(batch);

      expect(prompt).toContain('Analyze the following 1 emails');
      expect(prompt).toContain('EMAIL 1 (ID: email-1)');
      expect(prompt).toContain('Subject: Property at 123 Main St');
      // TASK-1075: Emails are now sanitized, so check for masked format
      expect(prompt).toContain('[EMAIL:');
      expect(prompt).toContain('Interested in this property?');
    });

    // TASK-1075: PII sanitization tests
    it('should sanitize PII in email content before formatting', () => {
      const batch = {
        batchId: 'test-batch',
        emails: [
          createEmail({
            id: 'email-1',
            subject: 'Call me at 555-555-0112',
            sender: 'john.doe@company.com',
            recipients: ['jane.doe@client.org'],
            date: '2024-01-15T10:00:00Z',
            body: 'My SSN is 123-45-6789. Please wire to account 987654321098.',
          }),
        ],
        estimatedTokens: 200,
      };

      const prompt = formatBatchPrompt(batch);

      // Should mask phone in subject
      expect(prompt).toContain('[PHONE:');
      // Should mask email addresses
      expect(prompt).toContain('[EMAIL:');
      // Should mask SSN
      expect(prompt).toContain('[SSN:');
      // Should NOT contain raw PII
      expect(prompt).not.toContain('john.doe@company.com');
      expect(prompt).not.toContain('jane.doe@client.org');
      expect(prompt).not.toContain('123-45-6789');
      expect(prompt).not.toContain('555-555-0112');
    });

    it('should preserve property addresses in email content', () => {
      const batch = {
        batchId: 'test-batch',
        emails: [
          createEmail({
            id: 'email-1',
            subject: 'Listing at 456 Oak Avenue',
            sender: 'agent@realty.com',
            body: 'Property at 789 Pine Street is listed for $500,000',
          }),
        ],
        estimatedTokens: 150,
      };

      const prompt = formatBatchPrompt(batch);

      // Property addresses should be preserved for real estate context
      expect(prompt).toContain('456 Oak Avenue');
      expect(prompt).toContain('789 Pine Street');
      expect(prompt).toContain('$500,000');
    });

    it('should sanitize multiple recipients', () => {
      const batch = {
        batchId: 'test-batch',
        emails: [
          createEmail({
            id: 'email-1',
            subject: 'Test',
            sender: 'sender@test.com',
            recipients: ['a@test.com', 'b@test.com', 'c@test.com'],
            body: 'Test body',
          }),
        ],
        estimatedTokens: 100,
      };

      const prompt = formatBatchPrompt(batch);

      // All recipients should be sanitized
      expect(prompt).not.toContain('a@test.com');
      expect(prompt).not.toContain('b@test.com');
      expect(prompt).not.toContain('c@test.com');
      // Should contain masked versions (3 [EMAIL: entries in To line)
      const toMatch = prompt.match(/To: .+/);
      expect(toMatch).toBeTruthy();
      expect(toMatch![0]).toContain('[EMAIL:');
    });

    it('should handle multiple emails in batch', () => {
      const batch = {
        batchId: 'test-batch',
        emails: [
          createEmail({ id: 'email-1', subject: 'First' }),
          createEmail({ id: 'email-2', subject: 'Second' }),
          createEmail({ id: 'email-3', subject: 'Third' }),
        ],
        estimatedTokens: 300,
      };

      const prompt = formatBatchPrompt(batch);

      expect(prompt).toContain('Analyze the following 3 emails');
      expect(prompt).toContain('EMAIL 1 (ID: email-1)');
      expect(prompt).toContain('EMAIL 2 (ID: email-2)');
      expect(prompt).toContain('EMAIL 3 (ID: email-3)');
    });

    it('should handle missing email fields gracefully', () => {
      const batch = {
        batchId: 'test-batch',
        emails: [
          createEmail({
            id: 'email-1',
            subject: '',
            sender: '',
            recipients: [],
            date: '',
            body: '',
          }),
        ],
        estimatedTokens: 50,
      };

      const prompt = formatBatchPrompt(batch);

      expect(prompt).toContain('Subject: (no subject)');
      expect(prompt).toContain('From: unknown');
      expect(prompt).toContain('To: unknown');
    });

    it('should include JSON format instructions', () => {
      const batch = {
        batchId: 'test-batch',
        emails: [createEmail({ id: 'email-1' })],
        estimatedTokens: 100,
      };

      const prompt = formatBatchPrompt(batch);

      expect(prompt).toContain('JSON array');
      expect(prompt).toContain('"isRealEstateRelated"');
      expect(prompt).toContain('"confidence"');
      expect(prompt).toContain('"transactionType"');
      expect(prompt).toContain('"propertyAddress"');
    });

    it('should truncate long bodies', () => {
      const longBody = 'x'.repeat(5000);
      const batch = {
        batchId: 'test-batch',
        emails: [createEmail({ id: 'email-1', body: longBody })],
        estimatedTokens: 700,
      };

      const prompt = formatBatchPrompt(batch);

      // Should be truncated to 2000 chars
      const bodyMatch = prompt.match(/Body:\n(x+)/);
      expect(bodyMatch).toBeTruthy();
      expect(bodyMatch![1].length).toBe(2000);
    });
  });

  // TASK-508: Response Parser Tests
  describe('extractJsonArray', () => {
    it('should extract JSON array from plain response', () => {
      const response = '[{"id": "1"}, {"id": "2"}]';
      const result = extractJsonArray(response);

      expect(result).toBe('[{"id": "1"}, {"id": "2"}]');
    });

    it('should extract JSON array from markdown code block', () => {
      const response = '```json\n[{"id": "1"}]\n```';
      const result = extractJsonArray(response);

      expect(result).toBe('[{"id": "1"}]');
    });

    it('should extract JSON array from plain code block', () => {
      const response = '```\n[{"id": "1"}]\n```';
      const result = extractJsonArray(response);

      expect(result).toBe('[{"id": "1"}]');
    });

    it('should extract array with text before and after', () => {
      const response = 'Here are the results:\n[{"id": "1"}]\nDone!';
      const result = extractJsonArray(response);

      expect(result).toBe('[{"id": "1"}]');
    });

    it('should return null for empty response', () => {
      expect(extractJsonArray('')).toBeNull();
      expect(extractJsonArray(null as any)).toBeNull();
      expect(extractJsonArray(undefined as any)).toBeNull();
    });

    it('should return null for response without array', () => {
      const response = 'No JSON here, just text';
      expect(extractJsonArray(response)).toBeNull();
    });
  });

  describe('parseBatchResponse', () => {
    const createMockBatch = (emailCount: number): EmailBatch => ({
      batchId: 'test-batch',
      emails: Array(emailCount)
        .fill(null)
        .map((_, i) => createEmail({ id: `email_${i + 1}` })),
      estimatedTokens: 1000,
    });

    it('should parse valid JSON array response', () => {
      const batch = createMockBatch(3);
      const response = `[
        { "isRealEstateRelated": true, "confidence": 0.9, "transactionType": "purchase" },
        { "isRealEstateRelated": false, "confidence": 0.1 },
        { "isRealEstateRelated": true, "confidence": 0.85, "propertyAddress": "123 Main St" }
      ]`;

      const result = parseBatchResponse(batch, response);

      expect(result.results.length).toBe(3);
      expect(result.errors.length).toBe(0);
      expect(result.stats.successful).toBe(3);
      expect(result.stats.failed).toBe(0);
      expect(result.stats.realEstateFound).toBe(2);

      expect(result.results[0]).toMatchObject({
        emailId: 'email_1',
        isRealEstateRelated: true,
        confidence: 0.9,
        transactionType: 'purchase',
      });

      expect(result.results[2]).toMatchObject({
        emailId: 'email_3',
        propertyAddress: '123 Main St',
      });
    });

    it('should handle response with markdown code blocks', () => {
      const batch = createMockBatch(1);
      const response = '```json\n[{"isRealEstateRelated": true, "confidence": 0.8}]\n```';

      const result = parseBatchResponse(batch, response);

      expect(result.results.length).toBe(1);
      expect(result.errors.length).toBe(0);
      expect(result.results[0].isRealEstateRelated).toBe(true);
    });

    it('should handle snake_case field names', () => {
      const batch = createMockBatch(1);
      const response = `[{
        "is_real_estate_related": true,
        "confidence": 0.7,
        "transaction_type": "sale",
        "property_address": "456 Oak Ave"
      }]`;

      const result = parseBatchResponse(batch, response);

      expect(result.results[0]).toMatchObject({
        isRealEstateRelated: true,
        transactionType: 'sale',
        propertyAddress: '456 Oak Ave',
      });
    });

    it('should handle parse errors gracefully', () => {
      const batch = createMockBatch(3);
      const response = 'invalid json';

      const result = parseBatchResponse(batch, response);

      expect(result.errors.length).toBe(3);
      expect(result.results.length).toBe(0);
      expect(result.stats.failed).toBe(3);
      expect(result.errors[0].error).toContain('No JSON array found');
    });

    it('should handle missing results for some emails', () => {
      const batch = createMockBatch(3);
      const response = `[
        { "isRealEstateRelated": true, "confidence": 0.9 },
        { "isRealEstateRelated": false, "confidence": 0.1 }
      ]`; // Only 2 results for 3 emails

      const result = parseBatchResponse(batch, response);

      expect(result.results.length).toBe(2);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toMatchObject({
        emailId: 'email_3',
        error: 'No result at index 2',
      });
    });

    it('should handle empty response', () => {
      const batch = createMockBatch(2);
      const response = '';

      const result = parseBatchResponse(batch, response);

      expect(result.errors.length).toBe(2);
      expect(result.results.length).toBe(0);
    });

    it('should preserve raw response in results', () => {
      const batch = createMockBatch(1);
      const response = '[{"isRealEstateRelated": true, "confidence": 0.9, "extra": "data"}]';

      const result = parseBatchResponse(batch, response);

      expect(result.results[0].rawResponse).toEqual({
        isRealEstateRelated: true,
        confidence: 0.9,
        extra: 'data',
      });
    });
  });

  describe('processBatchErrors', () => {
    it('should process errors with fallback analyzer', async () => {
      const errors = [
        { emailId: 'email_1', error: 'Parse failed' },
        { emailId: 'email_2', error: 'Parse failed' },
      ];

      const emailMap = new Map<string, MessageInput>([
        ['email_1', createEmail({ id: 'email_1' })],
        ['email_2', createEmail({ id: 'email_2' })],
      ]);

      const mockAnalyzer = jest.fn().mockResolvedValue({
        emailId: 'mock',
        isRealEstateRelated: true,
        confidence: 0.8,
      });

      const results = await processBatchErrors(errors, emailMap, mockAnalyzer);

      expect(mockAnalyzer).toHaveBeenCalledTimes(2);
      expect(results.length).toBe(2);
    });

    it('should skip emails not in map', async () => {
      const errors = [
        { emailId: 'email_1', error: 'Parse failed' },
        { emailId: 'unknown', error: 'Parse failed' },
      ];

      const emailMap = new Map<string, MessageInput>([
        ['email_1', createEmail({ id: 'email_1' })],
      ]);

      const mockAnalyzer = jest.fn().mockResolvedValue({
        emailId: 'mock',
        isRealEstateRelated: false,
        confidence: 0.5,
      });

      const results = await processBatchErrors(errors, emailMap, mockAnalyzer);

      expect(mockAnalyzer).toHaveBeenCalledTimes(1);
      expect(results.length).toBe(1);
    });

    it('should continue on analyzer failure', async () => {
      const errors = [
        { emailId: 'email_1', error: 'Parse failed' },
        { emailId: 'email_2', error: 'Parse failed' },
      ];

      const emailMap = new Map<string, MessageInput>([
        ['email_1', createEmail({ id: 'email_1' })],
        ['email_2', createEmail({ id: 'email_2' })],
      ]);

      const mockAnalyzer = jest
        .fn()
        .mockRejectedValueOnce(new Error('API error'))
        .mockResolvedValueOnce({
          emailId: 'email_2',
          isRealEstateRelated: true,
          confidence: 0.9,
        });

      const results = await processBatchErrors(errors, emailMap, mockAnalyzer);

      expect(results.length).toBe(1);
      expect(results[0].emailId).toBe('email_2');
    });
  });
});
