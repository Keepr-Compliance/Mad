/**
 * Mock LLM Responses
 * TASK-411: Mock responses for hybrid extraction integration tests
 *
 * These mocks simulate various LLM response scenarios:
 * - Successful analysis responses
 * - Error responses (timeout, API errors)
 * - Edge case responses (low confidence, ambiguous)
 */

import type { MessageAnalysis, ContactRoleExtraction, ClusterTransactionsOutput } from '../../electron/services/llm/tools/types';

/**
 * Successful message analysis responses for real estate emails.
 */
export const successfulAnalysisResponses: Record<string, {
  success: true;
  data: MessageAnalysis;
  tokensUsed: { prompt: number; completion: number; total: number };
  latencyMs: number;
}> = {
  // Response for msg-re-001 (Initial Offer)
  'msg-re-001': {
    success: true,
    data: {
      isRealEstateRelated: true,
      confidence: 0.95,
      transactionIndicators: {
        type: 'purchase',
        stage: 'pending',
      },
      extractedEntities: {
        addresses: [
          { value: '123 Main Street, San Francisco, CA 94102', confidence: 0.98 },
        ],
        amounts: [
          { value: 450000, context: 'purchase price' },
          { value: 9000, context: 'earnest money' },
        ],
        dates: [
          { value: '2024-01-30', type: 'closing' },
        ],
        contacts: [
          { name: 'John Smith', email: 'john.smith@abcrealty.com', suggestedRole: 'buyer_agent' },
          { name: 'Sarah Jones', email: 'sarah.jones@sellerrealty.com', suggestedRole: 'seller_agent' },
        ],
      },
      reasoning: 'Email contains purchase offer with specific property address, price, earnest money, and closing date. Multiple real estate professionals involved.',
    },
    tokensUsed: { prompt: 450, completion: 180, total: 630 },
    latencyMs: 1200,
  },

  // Response for msg-re-002 (Inspection Scheduling)
  'msg-re-002': {
    success: true,
    data: {
      isRealEstateRelated: true,
      confidence: 0.92,
      transactionIndicators: {
        type: 'purchase',
        stage: 'pending',
      },
      extractedEntities: {
        addresses: [
          { value: '123 Main Street, San Francisco, CA 94102', confidence: 0.95 },
        ],
        amounts: [],
        dates: [
          { value: '2024-01-20', type: 'other' },
        ],
        contacts: [
          { name: 'Mike Johnson', email: 'inspector@bayareahomeinspections.com', suggestedRole: 'inspector' },
        ],
      },
      reasoning: 'Home inspection scheduling email for property in active transaction.',
    },
    tokensUsed: { prompt: 380, completion: 120, total: 500 },
    latencyMs: 950,
  },

  // Response for msg-re-003 (Title Review)
  'msg-re-003': {
    success: true,
    data: {
      isRealEstateRelated: true,
      confidence: 0.97,
      transactionIndicators: {
        type: 'purchase',
        stage: 'closing',
      },
      extractedEntities: {
        addresses: [
          { value: '123 Main Street, San Francisco, CA 94102', confidence: 0.99 },
        ],
        amounts: [],
        dates: [],
        contacts: [
          { name: 'First American Title Company', email: 'escrow@firstam.com', suggestedRole: 'title_company' },
        ],
      },
      reasoning: 'Title commitment document with legal property details and APN number.',
    },
    tokensUsed: { prompt: 520, completion: 150, total: 670 },
    latencyMs: 1100,
  },

  // Response for lease transaction
  'msg-re-004': {
    success: true,
    data: {
      isRealEstateRelated: true,
      confidence: 0.88,
      transactionIndicators: {
        type: 'lease',
        stage: 'pending',
      },
      extractedEntities: {
        addresses: [
          { value: '456 Oak Avenue, Unit 2B, Oakland, CA 94612', confidence: 0.94 },
        ],
        amounts: [
          { value: 2500, context: 'monthly rent' },
          { value: 5000, context: 'security deposit' },
        ],
        dates: [
          { value: '2024-02-01', type: 'other' },
          { value: '2025-01-31', type: 'other' },
        ],
        contacts: [],
      },
      reasoning: 'Lease agreement with rental terms, security deposit, and lease period.',
    },
    tokensUsed: { prompt: 400, completion: 140, total: 540 },
    latencyMs: 980,
  },

  // Response for sale listing
  'msg-re-005': {
    success: true,
    data: {
      isRealEstateRelated: true,
      confidence: 0.94,
      transactionIndicators: {
        type: 'sale',
        stage: 'prospecting',
      },
      extractedEntities: {
        addresses: [
          { value: '789 Pine Street, Berkeley, CA 94710', confidence: 0.96 },
        ],
        amounts: [
          { value: 625000, context: 'listing price' },
        ],
        dates: [
          { value: '2024-02-03', type: 'other' },
          { value: '2024-02-04', type: 'other' },
        ],
        contacts: [
          { name: 'Lisa Chen', email: 'lisa.chen@berkeleyproperties.com', suggestedRole: 'listing_agent' },
        ],
      },
      reasoning: 'New listing announcement with property details, price, and open house dates. MLS number provided.',
    },
    tokensUsed: { prompt: 480, completion: 160, total: 640 },
    latencyMs: 1050,
  },

  // Response for counteroffer
  'msg-re-006': {
    success: true,
    data: {
      isRealEstateRelated: true,
      confidence: 0.91,
      transactionIndicators: {
        type: 'purchase',
        stage: 'active',
      },
      extractedEntities: {
        addresses: [
          { value: '321 Elm Drive, Palo Alto, CA 94301', confidence: 0.93 },
        ],
        amounts: [
          { value: 1250000, context: 'original offer' },
          { value: 1295000, context: 'counteroffer' },
        ],
        dates: [],
        contacts: [
          { name: 'Mark Wilson', email: 'mark.wilson@luxuryrealty.com', suggestedRole: 'seller_agent' },
        ],
      },
      reasoning: 'Counteroffer email with original and counter amounts for property purchase.',
    },
    tokensUsed: { prompt: 350, completion: 130, total: 480 },
    latencyMs: 890,
  },
};

/**
 * Non-real estate analysis responses.
 */
export const nonRealEstateAnalysisResponses: Record<string, {
  success: true;
  data: MessageAnalysis;
  tokensUsed: { prompt: number; completion: number; total: number };
  latencyMs: number;
}> = {
  'msg-nr-001': {
    success: true,
    data: {
      isRealEstateRelated: false,
      confidence: 0.15,
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
      reasoning: 'Technology newsletter with no real estate content.',
    },
    tokensUsed: { prompt: 200, completion: 80, total: 280 },
    latencyMs: 650,
  },
  'msg-nr-002': {
    success: true,
    data: {
      isRealEstateRelated: false,
      confidence: 0.08,
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
      reasoning: 'Personal dinner plans, not related to real estate.',
    },
    tokensUsed: { prompt: 180, completion: 70, total: 250 },
    latencyMs: 580,
  },
  'msg-nr-003': {
    success: true,
    data: {
      isRealEstateRelated: false,
      confidence: 0.05,
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
      reasoning: 'Corporate budget meeting invitation, no real estate relevance.',
    },
    tokensUsed: { prompt: 220, completion: 75, total: 295 },
    latencyMs: 620,
  },
};

/**
 * Successful clustering response.
 */
export const successfulClusteringResponse: {
  success: true;
  data: ClusterTransactionsOutput;
  tokensUsed: { prompt: number; completion: number; total: number };
  latencyMs: number;
} = {
  success: true,
  data: {
    clusters: [
      {
        clusterId: 'cluster-main-st',
        propertyAddress: '123 Main Street, San Francisco, CA 94102',
        confidence: 0.94,
        transactionType: 'purchase',
        stage: 'closing',
        communicationIds: ['msg-re-001', 'msg-re-002', 'msg-re-003'],
        dateRange: {
          start: '2024-01-15',
          end: '2024-01-22',
        },
        suggestedContacts: [
          { name: 'John Smith', email: 'john.smith@abcrealty.com', role: 'buyer_agent' },
          { name: 'Sarah Jones', email: 'sarah.jones@sellerrealty.com', role: 'seller_agent' },
        ],
        summary: 'Purchase transaction at 123 Main Street progressing through inspection to closing stage.',
      },
      {
        clusterId: 'cluster-oak-ave',
        propertyAddress: '456 Oak Avenue, Unit 2B, Oakland, CA 94612',
        confidence: 0.88,
        transactionType: 'lease',
        stage: 'pending',
        communicationIds: ['msg-re-004'],
        dateRange: {
          start: '2024-01-25',
          end: '2024-01-25',
        },
        suggestedContacts: [],
        summary: 'Lease agreement for rental property in Oakland.',
      },
      {
        clusterId: 'cluster-pine-st',
        propertyAddress: '789 Pine Street, Berkeley, CA 94710',
        confidence: 0.92,
        transactionType: 'sale',
        stage: 'prospecting',
        communicationIds: ['msg-re-005'],
        dateRange: {
          start: '2024-01-28',
          end: '2024-01-28',
        },
        suggestedContacts: [
          { name: 'Lisa Chen', email: 'lisa.chen@berkeleyproperties.com', role: 'listing_agent' },
        ],
        summary: 'New listing for sale in Berkeley with scheduled open houses.',
      },
    ],
    unclustered: [],
  },
  tokensUsed: { prompt: 1200, completion: 450, total: 1650 },
  latencyMs: 2500,
};

/**
 * Successful contact role extraction response.
 */
export const successfulContactExtractionResponse: {
  success: true;
  data: ContactRoleExtraction;
  tokensUsed: { prompt: number; completion: number; total: number };
  latencyMs: number;
} = {
  success: true,
  data: {
    assignments: [
      {
        name: 'John Smith',
        email: 'john.smith@abcrealty.com',
        role: 'agent',
        confidence: 0.95,
        evidence: ['Signs off as ABC Realty', 'Represents buyer in offer email'],
      },
      {
        name: 'Sarah Jones',
        email: 'sarah.jones@sellerrealty.com',
        role: 'agent',
        confidence: 0.92,
        evidence: ['Email domain sellerrealty.com', 'Receives offer on behalf of seller'],
      },
      {
        name: 'Mike Johnson',
        email: 'inspector@bayareahomeinspections.com',
        role: 'inspector',
        confidence: 0.98,
        evidence: ['Home inspection company', 'Scheduling inspection'],
      },
    ],
  },
  tokensUsed: { prompt: 800, completion: 300, total: 1100 },
  latencyMs: 1800,
};

/**
 * Error responses for fallback testing.
 */
export const errorResponses = {
  timeout: {
    success: false as const,
    error: {
      message: 'Request timeout after 30000ms',
      code: 'timeout',
      provider: 'openai' as const,
      statusCode: 408,
      retryable: true,
    },
  },
  rateLimited: {
    success: false as const,
    error: {
      message: 'Rate limit exceeded. Please retry after 60 seconds.',
      code: 'rate_limited',
      provider: 'openai' as const,
      statusCode: 429,
      retryable: true,
    },
  },
  invalidApiKey: {
    success: false as const,
    error: {
      message: 'Invalid API key provided',
      code: 'invalid_api_key',
      provider: 'openai' as const,
      statusCode: 401,
      retryable: false,
    },
  },
  serverError: {
    success: false as const,
    error: {
      message: 'Internal server error',
      code: 'server_error',
      provider: 'openai' as const,
      statusCode: 500,
      retryable: true,
    },
  },
  quotaExceeded: {
    success: false as const,
    error: {
      message: 'Monthly quota exceeded',
      code: 'quota_exceeded',
      provider: 'openai' as const,
      statusCode: 403,
      retryable: false,
    },
  },
};

/**
 * Low confidence / ambiguous responses.
 */
export const ambiguousResponses = {
  'msg-edge-001': {
    success: true as const,
    data: {
      isRealEstateRelated: true,
      confidence: 0.35, // Low confidence due to minimal content
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
      reasoning: 'Email mentions property but lacks sufficient detail for classification.',
    },
    tokensUsed: { prompt: 150, completion: 60, total: 210 },
    latencyMs: 450,
  },
  'msg-edge-003': {
    success: true as const,
    data: {
      isRealEstateRelated: false,
      confidence: 0.72, // Moderate confidence - ambiguous content
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
      reasoning: 'Email mentions "property" but refers to intellectual property (patents), not real estate.',
    },
    tokensUsed: { prompt: 280, completion: 90, total: 370 },
    latencyMs: 720,
  },
};

/**
 * Helper to create a mock analyze function.
 */
export function createMockAnalyzeFunction(
  responseMap: Record<string, unknown> = { ...successfulAnalysisResponses, ...nonRealEstateAnalysisResponses }
): jest.Mock {
  return jest.fn().mockImplementation((input: { subject?: string }, _config: unknown) => {
    // Try to find matching response by checking which message this might be
    for (const [msgId, response] of Object.entries(responseMap)) {
      if (input.subject && msgId.includes('re-001') && input.subject.includes('Offer on 123 Main St')) {
        return Promise.resolve(response);
      }
      if (input.subject && msgId.includes('re-002') && input.subject.includes('Inspection Scheduled')) {
        return Promise.resolve(response);
      }
      if (input.subject && msgId.includes('re-003') && input.subject.includes('Title Commitment')) {
        return Promise.resolve(response);
      }
      if (input.subject && msgId.includes('nr-001') && input.subject.includes('Newsletter')) {
        return Promise.resolve(response);
      }
    }
    // Default response for unmatched
    return Promise.resolve(successfulAnalysisResponses['msg-re-001']);
  });
}

/**
 * Mock LLM user config responses.
 */
export const mockUserConfigs = {
  fullyConfigured: {
    hasOpenAI: true,
    hasAnthropic: true,
    preferredProvider: 'openai' as const,
    openAIModel: 'gpt-4o-mini',
    anthropicModel: 'claude-3-haiku-20240307',
    tokensUsed: 5000,
    budgetLimit: 100000,
    platformAllowanceRemaining: 50000,
    usePlatformAllowance: false,
    autoDetectEnabled: true,
    roleExtractionEnabled: true,
    hasConsent: true,
  },
  noConsent: {
    hasOpenAI: true,
    hasAnthropic: false,
    preferredProvider: 'openai' as const,
    openAIModel: 'gpt-4o-mini',
    anthropicModel: 'claude-3-haiku-20240307',
    tokensUsed: 0,
    platformAllowanceRemaining: 50000,
    usePlatformAllowance: false,
    autoDetectEnabled: true,
    roleExtractionEnabled: true,
    hasConsent: false,
  },
  noApiKey: {
    hasOpenAI: false,
    hasAnthropic: false,
    preferredProvider: 'openai' as const,
    openAIModel: 'gpt-4o-mini',
    anthropicModel: 'claude-3-haiku-20240307',
    tokensUsed: 0,
    platformAllowanceRemaining: 50000,
    usePlatformAllowance: false,
    autoDetectEnabled: true,
    roleExtractionEnabled: true,
    hasConsent: true,
  },
  budgetExceeded: {
    hasOpenAI: true,
    hasAnthropic: false,
    preferredProvider: 'openai' as const,
    openAIModel: 'gpt-4o-mini',
    anthropicModel: 'claude-3-haiku-20240307',
    tokensUsed: 99500,
    budgetLimit: 100000,
    platformAllowanceRemaining: 0,
    usePlatformAllowance: false,
    autoDetectEnabled: true,
    roleExtractionEnabled: true,
    hasConsent: true,
  },
  platformAllowanceOnly: {
    hasOpenAI: false,
    hasAnthropic: false,
    preferredProvider: 'openai' as const,
    openAIModel: 'gpt-4o-mini',
    anthropicModel: 'claude-3-haiku-20240307',
    tokensUsed: 0,
    platformAllowanceRemaining: 25000,
    usePlatformAllowance: true,
    autoDetectEnabled: true,
    roleExtractionEnabled: true,
    hasConsent: true,
  },
};

/**
 * Mock LLM settings for database service.
 */
export const mockLLMSettings = {
  configured: {
    user_id: 'test-user',
    openai_api_key_encrypted: 'encrypted-openai-key',
    anthropic_api_key_encrypted: null,
    preferred_provider: 'openai' as const,
    openai_model: 'gpt-4o-mini',
    anthropic_model: 'claude-3-haiku-20240307',
    llm_data_consent: true,
    enable_auto_detect: true,
    enable_role_extraction: true,
    tokens_used_this_month: 5000,
    budget_limit_tokens: 100000,
    budget_reset_date: '2024-02-01',
    platform_allowance_tokens: 50000,
    platform_allowance_used: 0,
    use_platform_allowance: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-15T10:00:00Z',
  },
  notConfigured: null,
};

export default {
  successfulAnalysisResponses,
  nonRealEstateAnalysisResponses,
  successfulClusteringResponse,
  successfulContactExtractionResponse,
  errorResponses,
  ambiguousResponses,
  mockUserConfigs,
  mockLLMSettings,
  createMockAnalyzeFunction,
};
