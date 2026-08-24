/**
 * Unit tests for ExtractContactRolesTool
 * TASK-316: Contact Role Extractor Tool
 */

import { ExtractContactRolesTool } from '../extractContactRolesTool';
import { BaseLLMService } from '../../baseLLMService';
import { LLMConfig, LLMMessage, LLMResponse } from '../../types';
import { ExtractContactRolesInput, ContactRoleExtraction } from '../types';

// Mock BaseLLMService
class MockLLMService extends BaseLLMService {
  private mockResponse: string = '';
  private shouldThrow: boolean = false;
  private throwError?: Error;

  constructor() {
    super('openai');
  }

  setMockResponse(response: string): void {
    this.mockResponse = response;
    this.shouldThrow = false;
  }

  setMockError(error: Error): void {
    this.shouldThrow = true;
    this.throwError = error;
  }

  async complete(
    _messages: LLMMessage[],
    _config: LLMConfig
  ): Promise<LLMResponse> {
    if (this.shouldThrow && this.throwError) {
      throw this.throwError;
    }
    return {
      content: this.mockResponse,
      tokensUsed: { prompt: 200, completion: 100, total: 300 },
      model: 'gpt-4o-mini',
      finishReason: 'stop',
      latencyMs: 600,
    };
  }

  async validateApiKey(_apiKey: string): Promise<boolean> {
    return true;
  }
}

describe('ExtractContactRolesTool', () => {
  let tool: ExtractContactRolesTool;
  let mockService: MockLLMService;
  const testConfig: LLMConfig = {
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
  };

  const testInput: ExtractContactRolesInput = {
    communications: [
      {
        subject: 'Re: 123 Main St - Closing Documents',
        body: 'Hi John, I am the listing agent for this property. Please have the buyer review the attached documents. Best, Sarah Smith, RE/MAX Realty',
        sender: 'sarah.smith@remax.com',
        recipients: ['john.buyer@email.com'],
        date: '2024-01-15T10:30:00Z',
      },
      {
        subject: 'Re: 123 Main St - Closing Documents',
        body: 'Thanks Sarah. I will review with my client and get back to you. - John Doe, Buyer Agent',
        sender: 'john.doe@coldwell.com',
        recipients: ['sarah.smith@remax.com'],
        date: '2024-01-15T11:00:00Z',
      },
    ],
    propertyAddress: '123 Main St',
  };

  beforeEach(() => {
    mockService = new MockLLMService();
    tool = new ExtractContactRolesTool(mockService);
  });

  /**
   * WHAT THE MODEL SENDS — deliberately NOT `ContactRoleExtraction`.
   *
   * `ContactRoleExtraction.role` is `ContactRole`, the vocabulary the APP
   * writes. A model response is an untrusted external payload: it arrives as a
   * JSON string and is not bound by our union, and it still emits the retired
   * side-specific agent values because that vocabulary is decades old in its
   * training data (BACKLOG-2859).
   *
   * Typing these fixtures as `ContactRoleExtraction` asserted the opposite —
   * that the model cannot produce them — which is exactly the claim the fold
   * under test exists to falsify.
   */
  type RawModelResponse = {
    assignments: Array<{
      name: string;
      email?: string;
      phone?: string;
      role: string;
      confidence: number;
      evidence: string[];
    }>;
    transactionContext?: Record<string, unknown>;
  };

  describe('successful extraction', () => {
    it('should extract contact roles from buyer-side communication', async () => {
      const mockResponse: RawModelResponse = {
        assignments: [
          {
            name: 'Sarah Smith',
            email: 'sarah.smith@remax.com',
            role: 'seller_agent',
            confidence: 0.95,
            evidence: ['I am the listing agent for this property'],
          },
          {
            name: 'John Doe',
            email: 'john.doe@coldwell.com',
            role: 'buyer_agent',
            confidence: 0.9,
            evidence: ['John Doe, Buyer Agent'],
          },
        ],
        transactionContext: {
          propertyAddress: '123 Main St',
          transactionType: 'purchase',
        },
      };

      mockService.setMockResponse(JSON.stringify(mockResponse));

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.assignments).toHaveLength(2);
      // BACKLOG-2859: the MODEL still emits the retired side-specific values —
      // the fixtures above are deliberately left that way, because that is what
      // a real response looks like. The tool FOLDS them to the single `agent`
      // role rather than rejecting them. Rejection would send them to `other`,
      // which is unrecoverable: nothing downstream can tell an `other` that was
      // really an agent from a genuinely unclassifiable party.
      expect(result.data?.assignments[0].role).toBe('agent');
      expect(result.data?.assignments[1].role).toBe('agent');
    });

    it('should extract roles with evidence quotes', async () => {
      const mockResponse: ContactRoleExtraction = {
        assignments: [
          {
            name: 'Jane Escrow',
            email: 'jane@titleco.com',
            role: 'escrow',
            confidence: 0.85,
            evidence: ['Escrow Officer at Title Co', 'Please wire funds to our escrow account'],
          },
        ],
      };

      mockService.setMockResponse(JSON.stringify(mockResponse));

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments[0].evidence).toHaveLength(2);
      expect(result.data?.assignments[0].evidence).toContain('Escrow Officer at Title Co');
    });

    it('should handle multi-party extraction', async () => {
      const mockResponse: RawModelResponse = {
        assignments: [
          { name: 'Agent 1', role: 'buyer_agent', confidence: 0.9, evidence: [] },
          { name: 'Agent 2', role: 'seller_agent', confidence: 0.9, evidence: [] },
          { name: 'Lender', role: 'lender', confidence: 0.85, evidence: [] },
          { name: 'Inspector', role: 'inspector', confidence: 0.8, evidence: [] },
        ],
      };

      mockService.setMockResponse(JSON.stringify(mockResponse));

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments).toHaveLength(4);

      const roles = result.data?.assignments.map(a => a.role) ?? [];
      // Both agents fold to one role (BACKLOG-2859).
      expect(roles).toContain('agent');
      expect(roles.filter((r) => r === 'agent')).toHaveLength(2);
      expect(roles).not.toContain('buyer_agent');
      expect(roles).not.toContain('seller_agent');
      expect(roles).toContain('lender');
      expect(roles).toContain('inspector');
    });
  });

  describe('handling ambiguous cases', () => {
    it('should assign lower confidence for ambiguous roles', async () => {
      const mockResponse: ContactRoleExtraction = {
        assignments: [
          {
            name: 'Unknown Person',
            role: 'other',
            confidence: 0.3,
            evidence: ['Could not determine role from context'],
          },
        ],
      };

      mockService.setMockResponse(JSON.stringify(mockResponse));

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments[0].confidence).toBeLessThan(0.5);
      expect(result.data?.assignments[0].role).toBe('other');
    });
  });

  describe('empty inputs', () => {
    it('should return empty assignments for empty communications array', async () => {
      const result = await tool.extract({ communications: [] }, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments).toHaveLength(0);
    });

    it('should return empty assignments for non-RE communications', async () => {
      const mockResponse: ContactRoleExtraction = {
        assignments: [],
      };

      mockService.setMockResponse(JSON.stringify(mockResponse));

      const result = await tool.extract(
        {
          communications: [
            {
              subject: 'Newsletter',
              body: 'Check out our deals!',
              sender: 'marketing@store.com',
              recipients: ['user@email.com'],
              date: '2024-01-15T10:00:00Z',
            },
          ],
        },
        testConfig
      );

      expect(result.success).toBe(true);
      expect(result.data?.assignments).toHaveLength(0);
    });
  });

  describe('JSON parsing', () => {
    it('should parse JSON wrapped in code blocks', async () => {
      const jsonContent = JSON.stringify({
        assignments: [
          { name: 'Test User', role: 'buyer', confidence: 0.8, evidence: [] },
        ],
      });

      mockService.setMockResponse('```json\n' + jsonContent + '\n```');

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments).toHaveLength(1);
    });

    it('should handle malformed JSON gracefully', async () => {
      mockService.setMockResponse('{ invalid json }');

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('validation', () => {
    it('should normalize invalid roles to "other"', async () => {
      mockService.setMockResponse(
        JSON.stringify({
          assignments: [
            { name: 'Test', role: 'invalid_role', confidence: 0.8, evidence: [] },
          ],
        })
      );

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments[0].role).toBe('other');
    });

    it('should clamp confidence to 0-1 range', async () => {
      mockService.setMockResponse(
        JSON.stringify({
          assignments: [
            { name: 'Test 1', role: 'buyer', confidence: 1.5, evidence: [] },
            { name: 'Test 2', role: 'seller', confidence: -0.5, evidence: [] },
          ],
        })
      );

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments[0].confidence).toBe(1);
      expect(result.data?.assignments[1].confidence).toBe(0);
    });

    it('should filter out entries with empty names', async () => {
      mockService.setMockResponse(
        JSON.stringify({
          assignments: [
            { name: '', role: 'buyer', confidence: 0.8, evidence: [] },
            { name: 'Valid Name', role: 'seller', confidence: 0.9, evidence: [] },
          ],
        })
      );

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments).toHaveLength(1);
      expect(result.data?.assignments[0].name).toBe('Valid Name');
    });

    it('should validate transaction context types', async () => {
      mockService.setMockResponse(
        JSON.stringify({
          assignments: [],
          transactionContext: {
            propertyAddress: '123 Test St',
            transactionType: 'invalid_type',
          },
        })
      );

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.transactionContext?.propertyAddress).toBe('123 Test St');
      expect(result.data?.transactionContext?.transactionType).toBeUndefined();
    });
  });

  describe('known contacts', () => {
    it('should include known contacts in prompt context', async () => {
      const mockResponse: ContactRoleExtraction = {
        assignments: [
          {
            name: 'John Smith',
            email: 'john@email.com',
            role: 'buyer',
            confidence: 0.9,
            evidence: [],
          },
        ],
      };

      mockService.setMockResponse(JSON.stringify(mockResponse));

      const inputWithKnown: ExtractContactRolesInput = {
        ...testInput,
        knownContacts: [
          { name: 'John Smith', email: 'john@email.com' },
          { name: 'Jane Doe', phone: '555-1234' },
        ],
      };

      const result = await tool.extract(inputWithKnown, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.assignments[0].name).toBe('John Smith');
    });
  });

  describe('error handling', () => {
    it('should handle LLM service errors', async () => {
      mockService.setMockError(new Error('Rate limit exceeded'));

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limit exceeded');
    });

    it('should include latencyMs in error results', async () => {
      mockService.setMockError(new Error('Network error'));

      const result = await tool.extract(testInput, testConfig);

      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('result structure', () => {
    it('should include all expected fields on success', async () => {
      mockService.setMockResponse(
        JSON.stringify({
          assignments: [
            { name: 'Test', role: 'buyer', confidence: 0.8, evidence: ['test'] },
          ],
          transactionContext: {
            propertyAddress: '123 Test St',
            transactionType: 'purchase',
          },
        })
      );

      const result = await tool.extract(testInput, testConfig);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.tokensUsed).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.data?.assignments[0]).toHaveProperty('name');
      expect(result.data?.assignments[0]).toHaveProperty('role');
      expect(result.data?.assignments[0]).toHaveProperty('confidence');
      expect(result.data?.assignments[0]).toHaveProperty('evidence');
    });
  });
});
