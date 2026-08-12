/**
 * Unit tests for ClusterTransactionsTool
 * TASK-317: Transaction Clusterer Tool
 */

import { ClusterTransactionsTool } from '../clusterTransactionsTool';
import { BaseLLMService } from '../../baseLLMService';
import { LLMConfig, LLMMessage, LLMResponse } from '../../types';
import {
  ClusterTransactionsInput,
  ClusterTransactionsOutput,
  MessageAnalysis,
  TransactionCluster,
} from '../types';

/**
 * Shape of the RAW LLM JSON that `parseClusterResponse` consumes. This is NOT
 * `ClusterTransactionsOutput`: the model emits `messageIds`, and the tool derives
 * `clusterId`, `communicationIds`, `dateRange` and `suggestedContacts` from it.
 * The fixtures below are fed through `JSON.stringify` as a model response, so they
 * are typed against the model-facing shape rather than the tool's return type.
 */
type LlmClusterResponse = Omit<ClusterTransactionsOutput, 'clusters'> & {
  clusters: Array<
    Pick<
      TransactionCluster,
      'propertyAddress' | 'transactionType' | 'stage' | 'confidence' | 'summary'
    > & { messageIds: string[] }
  >;
};

// Mock uuid
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-1234'),
}));

// Mock BaseLLMService
class MockLLMService extends BaseLLMService {
  private mockResponse: string = '';
  private shouldThrow: boolean = false;
  private throwError?: Error;
  public callCount: number = 0;

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
    this.callCount++;
    if (this.shouldThrow && this.throwError) {
      throw this.throwError;
    }
    return {
      content: this.mockResponse,
      tokensUsed: { prompt: 300, completion: 150, total: 450 },
      model: 'gpt-4o-mini',
      finishReason: 'stop',
      latencyMs: 700,
    };
  }

  async validateApiKey(_apiKey: string): Promise<boolean> {
    return true;
  }
}

// Helper to create a mock MessageAnalysis
function createMockAnalysis(overrides: Partial<MessageAnalysis> = {}): MessageAnalysis {
  return {
    isRealEstateRelated: true,
    confidence: 0.9,
    transactionIndicators: {
      type: 'purchase',
      stage: 'active',
    },
    extractedEntities: {
      addresses: [{ value: '123 Main St', confidence: 0.9 }],
      amounts: [],
      dates: [],
      contacts: [],
    },
    reasoning: 'Test analysis',
    ...overrides,
  };
}

describe('ClusterTransactionsTool', () => {
  let tool: ClusterTransactionsTool;
  let mockService: MockLLMService;
  const testConfig: LLMConfig = {
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
  };

  beforeEach(() => {
    mockService = new MockLLMService();
    tool = new ClusterTransactionsTool(mockService);
    jest.clearAllMocks();
  });

  describe('single-address clustering (no LLM needed)', () => {
    it('should cluster messages with same address without LLM call', async () => {
      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Re: 123 Main St',
            sender: 'agent@email.com',
            recipients: ['buyer@email.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis(),
          },
          {
            id: 'msg-2',
            subject: 'Re: 123 Main St - Update',
            sender: 'buyer@email.com',
            recipients: ['agent@email.com'],
            date: '2024-01-16T10:00:00Z',
            analysis: createMockAnalysis(),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters).toHaveLength(1);
      expect(result.data?.clusters[0].propertyAddress).toBe('123 main st');
      expect(result.data?.clusters[0].communicationIds).toContain('msg-1');
      expect(result.data?.clusters[0].communicationIds).toContain('msg-2');
      expect(mockService.callCount).toBe(0); // No LLM call needed
    });

    it('should calculate correct date range', async () => {
      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'First',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-10T10:00:00Z',
            analysis: createMockAnalysis(),
          },
          {
            id: 'msg-2',
            subject: 'Last',
            sender: 'c@d.com',
            recipients: ['a@b.com'],
            date: '2024-01-20T10:00:00Z',
            analysis: createMockAnalysis(),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(new Date(result.data!.clusters[0].dateRange.start).toISOString()).toBe('2024-01-10T10:00:00.000Z');
      expect(new Date(result.data!.clusters[0].dateRange.end).toISOString()).toBe('2024-01-20T10:00:00.000Z');
    });

    it('should aggregate contacts from messages', async () => {
      const analysisWithContacts = createMockAnalysis({
        extractedEntities: {
          addresses: [{ value: '123 Main St', confidence: 0.9 }],
          amounts: [],
          dates: [],
          contacts: [
            { name: 'John Doe', email: 'john@email.com', suggestedRole: 'buyer' },
          ],
        },
      });

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: analysisWithContacts,
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters[0].suggestedContacts).toHaveLength(1);
      expect(result.data?.clusters[0].suggestedContacts[0].name).toBe('John Doe');
    });

    it('should aggregate confidence from message analyses', async () => {
      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({ confidence: 0.8 }),
          },
          {
            id: 'msg-2',
            subject: 'Test 2',
            sender: 'c@d.com',
            recipients: ['a@b.com'],
            date: '2024-01-16T10:00:00Z',
            analysis: createMockAnalysis({ confidence: 0.6 }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters[0].confidence).toBe(0.7); // Average of 0.8 and 0.6
    });
  });

  describe('multi-address clustering (LLM path)', () => {
    it('should use LLM for messages with different addresses', async () => {
      const mockOutput: LlmClusterResponse = {
        clusters: [
          {
            propertyAddress: '123 Main St',
            messageIds: ['msg-1'],
            transactionType: 'purchase',
            stage: 'active',
            confidence: 0.9,
            summary: 'Purchase at 123 Main St',
          },
          {
            propertyAddress: '456 Oak Ave',
            messageIds: ['msg-2'],
            transactionType: 'sale',
            stage: 'closing',
            confidence: 0.85,
            summary: 'Sale at 456 Oak Ave',
          },
        ],
        unclustered: [],
      };

      mockService.setMockResponse(JSON.stringify(mockOutput));

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: '123 Main St',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [{ value: '123 Main St', confidence: 0.9 }],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
          {
            id: 'msg-2',
            subject: '456 Oak Ave',
            sender: 'x@y.com',
            recipients: ['z@w.com'],
            date: '2024-01-16T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [{ value: '456 Oak Ave', confidence: 0.85 }],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters).toHaveLength(2);
      expect(mockService.callCount).toBe(1); // LLM was called
    });

    it('should handle unclustered messages', async () => {
      const mockOutput: LlmClusterResponse = {
        clusters: [
          {
            propertyAddress: '123 Main St',
            messageIds: ['msg-1'],
            transactionType: 'purchase',
            stage: 'active',
            confidence: 0.9,
            summary: 'Test',
          },
        ],
        unclustered: ['msg-2', 'msg-3'],
      };

      mockService.setMockResponse(JSON.stringify(mockOutput));

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'RE email',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis(),
          },
          {
            id: 'msg-2',
            subject: 'Unknown',
            sender: 'x@y.com',
            recipients: ['z@w.com'],
            date: '2024-01-16T10:00:00Z',
            analysis: createMockAnalysis({
              isRealEstateRelated: false,
              confidence: 0.2,
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
          {
            id: 'msg-3',
            subject: 'Also unknown',
            sender: 'p@q.com',
            recipients: ['r@s.com'],
            date: '2024-01-17T10:00:00Z',
            analysis: createMockAnalysis({
              isRealEstateRelated: false,
              confidence: 0.1,
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.unclustered).toContain('msg-2');
      expect(result.data?.unclustered).toContain('msg-3');
    });
  });

  describe('empty inputs', () => {
    it('should handle empty messages array', async () => {
      const result = await tool.cluster({ analyzedMessages: [] }, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters).toHaveLength(0);
      expect(result.data?.unclustered).toHaveLength(0);
      expect(mockService.callCount).toBe(0);
    });
  });

  describe('existing transactions context', () => {
    it('should include existing transactions in LLM prompt', async () => {
      const mockOutput: LlmClusterResponse = {
        clusters: [
          {
            propertyAddress: '123 Main St',
            messageIds: ['msg-1'],
            transactionType: 'purchase',
            stage: 'active',
            confidence: 0.9,
            summary: 'Test',
          },
        ],
        unclustered: [],
      };

      mockService.setMockResponse(JSON.stringify(mockOutput));

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
        existingTransactions: [
          { id: 'tx-1', propertyAddress: '123 Main St', transactionType: 'purchase' },
          { id: 'tx-2', propertyAddress: '789 Elm Dr', transactionType: 'sale' },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(mockService.callCount).toBe(1); // LLM was called because address is unknown
    });
  });

  describe('JSON parsing', () => {
    it('should parse JSON wrapped in code blocks', async () => {
      const jsonContent = JSON.stringify({
        clusters: [
          {
            propertyAddress: '123 Test St',
            messageIds: ['msg-1'],
            confidence: 0.8,
            summary: 'Test',
          },
        ],
        unclustered: [],
      });

      mockService.setMockResponse('```json\n' + jsonContent + '\n```');

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters).toHaveLength(1);
    });

    it('should handle malformed JSON gracefully', async () => {
      mockService.setMockResponse('{ invalid json }');

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('validation', () => {
    it('should clamp confidence to 0-1 range', async () => {
      mockService.setMockResponse(
        JSON.stringify({
          clusters: [
            {
              propertyAddress: '123 Test St',
              messageIds: ['msg-1'],
              confidence: 1.5,
              summary: 'Test',
            },
          ],
          unclustered: [],
        })
      );

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters[0].confidence).toBe(1);
    });

    it('should validate transaction types', async () => {
      mockService.setMockResponse(
        JSON.stringify({
          clusters: [
            {
              propertyAddress: '123 Test St',
              messageIds: ['msg-1'],
              confidence: 0.8,
              transactionType: 'invalid',
              stage: 'unknown',
              summary: 'Test',
            },
          ],
          unclustered: [],
        })
      );

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters[0].transactionType).toBeNull();
      expect(result.data?.clusters[0].stage).toBeNull();
    });
  });

  describe('cluster summary generation', () => {
    it('should generate human-readable summary', async () => {
      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              transactionIndicators: {
                type: 'purchase',
                stage: 'closing',
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters[0].summary).toContain('purchase');
      expect(result.data?.clusters[0].summary).toContain('123 main st');
      expect(result.data?.clusters[0].summary).toContain('closing');
    });
  });

  describe('error handling', () => {
    it('should handle LLM service errors', async () => {
      mockService.setMockError(new Error('API error'));

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('API error');
    });

    it('should include latencyMs in all results', async () => {
      mockService.setMockError(new Error('Test error'));

      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis({
              extractedEntities: {
                addresses: [],
                amounts: [],
                dates: [],
                contacts: [],
              },
            }),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('result structure', () => {
    it('should generate cluster IDs', async () => {
      const input: ClusterTransactionsInput = {
        analyzedMessages: [
          {
            id: 'msg-1',
            subject: 'Test',
            sender: 'a@b.com',
            recipients: ['c@d.com'],
            date: '2024-01-15T10:00:00Z',
            analysis: createMockAnalysis(),
          },
        ],
      };

      const result = await tool.cluster(input, testConfig);

      expect(result.success).toBe(true);
      expect(result.data?.clusters[0].clusterId).toBe('mock-uuid-1234');
    });
  });
});
