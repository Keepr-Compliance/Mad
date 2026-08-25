/**
 * Shared Test Utilities for LLM Services
 * TASK-324: Unit Tests for AI Tools & Pipeline
 *
 * Provides reusable mock implementations and sample data for testing
 * LLM tools and hybrid extraction pipeline.
 */

import { BaseLLMService } from '../baseLLMService';
import { LLMConfig, LLMMessage, LLMResponse, LLMProvider } from '../types';
import { MessageAnalysis, ContactRoleExtraction, ClusterTransactionsOutput } from '../tools/types';

// =============================================================================
// Mock LLM Service
// =============================================================================

/**
 * Configurable mock LLM service for testing tools
 * Extends BaseLLMService to properly mock the abstract class
 */
export class MockLLMService extends BaseLLMService {
  private mockResponse: string = '';
  private shouldThrow: boolean = false;
  private throwError?: Error;
  public callCount: number = 0;
  private tokensUsed = { prompt: 100, completion: 50, total: 150 };
  private latencyMs = 500;

  constructor(provider: LLMProvider = 'openai') {
    super(provider);
  }

  /**
   * Set the response that will be returned by complete()
   */
  setMockResponse(response: string): void {
    this.mockResponse = response;
    this.shouldThrow = false;
  }

  /**
   * Set an error that will be thrown by complete()
   */
  setMockError(error: Error): void {
    this.shouldThrow = true;
    this.throwError = error;
  }

  /**
   * Configure token usage for the response
   */
  setTokensUsed(tokens: { prompt: number; completion: number; total: number }): void {
    this.tokensUsed = tokens;
  }

  /**
   * Configure latency for the response
   */
  setLatencyMs(ms: number): void {
    this.latencyMs = ms;
  }

  /**
   * Reset call count and configuration
   */
  reset(): void {
    this.callCount = 0;
    this.mockResponse = '';
    this.shouldThrow = false;
    this.throwError = undefined;
    this.tokensUsed = { prompt: 100, completion: 50, total: 150 };
    this.latencyMs = 500;
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
      tokensUsed: this.tokensUsed,
      model: 'gpt-4o-mini',
      finishReason: 'stop',
      latencyMs: this.latencyMs,
    };
  }

  async validateApiKey(_apiKey: string): Promise<boolean> {
    return true;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a mock LLM service instance
 */
export function createMockLLMService(provider: LLMProvider = 'openai'): MockLLMService {
  return new MockLLMService(provider);
}

/**
 * Create a mock LLM response object
 */
export function createMockLLMResponse(
  content: string,
  tokens = { prompt: 100, completion: 50, total: 150 },
  latencyMs = 500
): LLMResponse {
  return {
    content,
    tokensUsed: tokens,
    model: 'gpt-4o-mini',
    finishReason: 'stop',
    latencyMs,
  };
}

/**
 * Create a test LLM config
 */
export function createTestLLMConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  return {
    provider: 'openai',
    apiKey: 'test-api-key',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

// =============================================================================
// Sample Test Data
// =============================================================================

/**
 * Sample real estate email for testing
 */
export const SAMPLE_RE_EMAIL = {
  subject: 'Closing Documents for 123 Main St',
  body: 'Please review the closing documents for the property at 123 Main Street, Seattle, WA 98101. The closing date is January 15, 2025. Sale price: $750,000.',
  sender: 'agent@realty.com',
  recipients: ['buyer@email.com', 'seller@email.com'],
  date: '2024-12-18T10:00:00Z',
};

/**
 * Sample non-real estate email for testing
 */
export const SAMPLE_NON_RE_EMAIL = {
  subject: 'Weekly Newsletter',
  body: 'Check out our latest blog posts about technology trends.',
  sender: 'newsletter@tech.com',
  recipients: ['reader@email.com'],
  date: '2024-12-18T10:00:00Z',
};

/**
 * Sample message analysis response from LLM
 */
export const SAMPLE_MESSAGE_ANALYSIS_RESPONSE: MessageAnalysis = {
  isRealEstateRelated: true,
  confidence: 0.92,
  transactionIndicators: {
    type: 'purchase',
    stage: 'closing',
  },
  extractedEntities: {
    addresses: [{ value: '123 Main Street, Seattle, WA 98101', confidence: 0.95 }],
    amounts: [{ value: 750000, context: 'sale price' }],
    dates: [{ value: '2025-01-15', type: 'closing' }],
    contacts: [
      { name: 'Agent', email: 'agent@realty.com', suggestedRole: 'buyer_agent' },
    ],
  },
  reasoning: 'Email contains closing documents reference, property address, and sale price.',
};

/**
 * Sample non-RE message analysis response
 */
export const SAMPLE_NON_RE_ANALYSIS_RESPONSE: MessageAnalysis = {
  isRealEstateRelated: false,
  confidence: 0.1,
  transactionIndicators: {
    type: null,
    stage: null,
  },
  extractedEntities: {
    addresses: [],
    amounts: [],
    dates: [],
    contacts: [],
  },
  reasoning: 'This appears to be a marketing email unrelated to real estate.',
};

/**
 * Sample contact role extraction response
 */
export const SAMPLE_CONTACT_ROLES_RESPONSE: ContactRoleExtraction = {
  assignments: [
    {
      name: 'Sarah Smith',
      email: 'sarah.smith@remax.com',
      role: 'agent',
      confidence: 0.95,
      evidence: ['I am the listing agent for this property'],
    },
    {
      name: 'John Doe',
      email: 'john.doe@coldwell.com',
      role: 'agent',
      confidence: 0.9,
      evidence: ['John Doe, Buyer Agent'],
    },
  ],
  transactionContext: {
    propertyAddress: '123 Main St',
    transactionType: 'purchase',
  },
};

/**
 * Sample transaction clustering response
 */
export const SAMPLE_CLUSTERING_RESPONSE: ClusterTransactionsOutput = {
  clusters: [
    {
      clusterId: 'cluster-1',
      propertyAddress: '123 Main St',
      communicationIds: ['msg-1', 'msg-2'],
      transactionType: 'purchase',
      stage: 'closing',
      confidence: 0.9,
      dateRange: { start: '2024-01-15', end: '2024-01-20' },
      suggestedContacts: [{ name: 'Agent', email: 'agent@realty.com', role: 'buyer_agent' }],
      summary: 'Purchase transaction at 123 Main St - closing phase',
    },
    {
      clusterId: 'cluster-2',
      propertyAddress: '456 Oak Ave',
      communicationIds: ['msg-3'],
      transactionType: 'sale',
      stage: 'active',
      confidence: 0.85,
      dateRange: { start: '2024-01-10', end: '2024-01-18' },
      suggestedContacts: [],
      summary: 'Active sale listing at 456 Oak Ave',
    },
  ],
  unclustered: ['msg-4'],
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Wrap JSON response in code blocks (simulates LLM response format)
 */
export function wrapInCodeBlock(json: object): string {
  return '```json\n' + JSON.stringify(json, null, 2) + '\n```';
}

/**
 * Create a malformed JSON string for error testing
 */
export function createMalformedJSON(): string {
  return '{ invalid json }';
}

/**
 * Create a partial/incomplete response for validation testing
 */
export function createPartialResponse(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

/**
 * Create sample analyzed message for clustering tests
 */
export function createAnalyzedMessage(overrides: Partial<{
  id: string;
  subject: string;
  sender: string;
  recipients: string[];
  date: string;
  analysis: MessageAnalysis;
}> = {}) {
  return {
    id: overrides.id ?? 'msg-1',
    subject: overrides.subject ?? 'Re: 123 Main St',
    sender: overrides.sender ?? 'agent@email.com',
    recipients: overrides.recipients ?? ['buyer@email.com'],
    date: overrides.date ?? '2024-01-15T10:00:00Z',
    analysis: overrides.analysis ?? { ...SAMPLE_MESSAGE_ANALYSIS_RESPONSE },
  };
}

/**
 * Create test communications for contact role extraction
 */
export function createTestCommunications(count: number = 2) {
  return Array.from({ length: count }, (_, i) => ({
    subject: `Re: 123 Main St - Email ${i + 1}`,
    body: `Email body content ${i + 1}`,
    sender: `sender${i + 1}@email.com`,
    recipients: [`recipient${i + 1}@email.com`],
    date: `2024-01-${15 + i}T10:00:00Z`,
  }));
}
