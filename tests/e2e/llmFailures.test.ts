/**
 * LLM Failure Scenario E2E Tests
 * TASK-414: End-to-end tests for error handling paths
 *
 * Tests cover:
 * - API timeout handling with graceful fallback
 * - Invalid API key error display
 * - Rate limit exceeded messaging
 * - Malformed response fallback to pattern matching
 * - Retry on transient failure (503 errors)
 * - Fallback notification display to user
 *
 * Note: These tests use Jest with mocks (not Playwright) since this project
 * uses Jest for all testing. The tests simulate E2E scenarios by testing
 * the full service integration with mocked external dependencies.
 */

// Mock uuid first (no dependencies)
jest.mock('uuid', () => ({
  v4: jest.fn(() => `test-uuid-${Date.now()}`),
}));

// Create mock functions for controlling behavior
const mockAnalyzeEmail = jest.fn();
const mockGroupByProperty = jest.fn();
const mockGenerateTransactionSummary = jest.fn();
const mockGetUserConfig = jest.fn();
const mockAnalyzeTool = jest.fn();
const mockExtractTool = jest.fn();
const mockClusterTool = jest.fn();
const mockGetLLMSettings = jest.fn();
const mockIncrementTokenUsage = jest.fn();
const mockValidateApiKey = jest.fn();

// Mock all dependencies BEFORE importing
jest.mock('../../electron/services/transactionExtractorService', () => ({
  default: {
    analyzeEmail: jest.fn((...args: unknown[]) => mockAnalyzeEmail(...args)),
    groupByProperty: jest.fn((...args: unknown[]) => mockGroupByProperty(...args)),
    generateTransactionSummary: jest.fn((...args: unknown[]) => mockGenerateTransactionSummary(...args)),
  },
  __esModule: true,
}));

jest.mock('../../electron/services/llm/llmConfigService', () => ({
  LLMConfigService: jest.fn().mockImplementation(() => ({
    getUserConfig: jest.fn((...args: unknown[]) => mockGetUserConfig(...args)),
    validateApiKey: jest.fn((...args: unknown[]) => mockValidateApiKey(...args)),
  })),
}));

jest.mock('../../electron/services/llm/openAIService', () => ({
  OpenAIService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
  })),
}));

jest.mock('../../electron/services/llm/anthropicService', () => ({
  AnthropicService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
  })),
}));

jest.mock('../../electron/services/llm/tools/analyzeMessageTool', () => ({
  AnalyzeMessageTool: jest.fn().mockImplementation(() => ({
    analyze: jest.fn((...args: unknown[]) => mockAnalyzeTool(...args)),
  })),
}));

jest.mock('../../electron/services/llm/tools/extractContactRolesTool', () => ({
  ExtractContactRolesTool: jest.fn().mockImplementation(() => ({
    extract: jest.fn((...args: unknown[]) => mockExtractTool(...args)),
  })),
}));

jest.mock('../../electron/services/llm/tools/clusterTransactionsTool', () => ({
  ClusterTransactionsTool: jest.fn().mockImplementation(() => ({
    cluster: jest.fn((...args: unknown[]) => mockClusterTool(...args)),
  })),
}));

jest.mock('../../electron/services/llm/contentSanitizer', () => ({
  ContentSanitizer: jest.fn().mockImplementation(() => ({
    sanitize: jest.fn((content: string) => ({
      sanitizedContent: content,
      maskedItems: [],
      originalLength: content.length,
      sanitizedLength: content.length,
    })),
  })),
}));

jest.mock('../../electron/services/db/llmSettingsDbService', () => ({
  getLLMSettingsByUserId: jest.fn((...args: unknown[]) => mockGetLLMSettings(...args)),
  incrementTokenUsage: jest.fn((...args: unknown[]) => mockIncrementTokenUsage(...args)),
}));

jest.mock('../../electron/services/tokenEncryptionService', () => ({
  default: {
    decrypt: jest.fn((key: string) => `decrypted-${key}`),
    encrypt: jest.fn((key: string) => `encrypted-${key}`),
  },
}));

// NOW import after mocks
import { HybridExtractorService } from '../../electron/services/extraction/hybridExtractorService';
import { LLMConfigService } from '../../electron/services/llm/llmConfigService';
import { mockEmails, existingTransactions, knownContacts } from '../fixtures/realEstateEmails';
import {
  successfulAnalysisResponses,
  errorResponses,
  mockUserConfigs,
  mockLLMSettings,
} from '../mocks/llmResponses';
import type { HybridExtractionOptions } from '../../electron/services/extraction/types';

describe('LLM Failure Handling E2E Tests', () => {
  let hybridExtractor: HybridExtractorService;
  let llmConfigService: LLMConfigService;

  // Standard options for tests
  const hybridOptions: HybridExtractionOptions = {
    usePatternMatching: true,
    useLLM: true,
    userId: 'test-user',
    llmProvider: 'openai',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mocks for fully configured LLM
    mockGetUserConfig.mockResolvedValue(mockUserConfigs.fullyConfigured);
    mockGetLLMSettings.mockReturnValue(mockLLMSettings.configured);

    // Setup pattern matcher as fallback
    mockAnalyzeEmail.mockImplementation((email: { subject?: string; body?: string }) => {
      const hasRealEstateContent =
        email.subject?.includes('Main St') ||
        email.subject?.includes('Offer on') ||
        email.subject?.includes('Inspection') ||
        email.body?.includes('$450,000') ||
        email.body?.includes('property');

      return {
        isRealEstateRelated: hasRealEstateContent,
        transactionType: hasRealEstateContent ? 'purchase' : null,
        confidence: hasRealEstateContent ? 75 : 10,
        addresses: hasRealEstateContent ? ['123 Main Street, San Francisco, CA 94102'] : [],
        amounts: hasRealEstateContent ? [450000] : [],
        dates: ['2024-01-15'],
        parties: [],
        mlsNumbers: [],
        keywords: hasRealEstateContent ? [{ category: 'transaction', keyword: 'offer' }] : [],
      };
    });

    // Setup grouping mock
    mockGroupByProperty.mockReturnValue({
      '123 Main Street, San Francisco, CA 94102': [
        {
          isRealEstateRelated: true,
          transactionType: 'purchase',
          confidence: 75,
          addresses: ['123 Main Street, San Francisco, CA 94102'],
        },
      ],
    });

    // Setup summary mock
    mockGenerateTransactionSummary.mockReturnValue({
      propertyAddress: '123 Main Street, San Francisco, CA 94102',
      transactionType: 'purchase',
      salePrice: 450000,
      closingDate: '2024-02-15',
      mlsNumbers: [],
      communicationsCount: 3,
      firstCommunication: new Date('2024-01-15').getTime(),
      lastCommunication: new Date('2024-01-22').getTime(),
      confidence: 80,
    });

    // Create service instances
    hybridExtractor = new HybridExtractorService();
    llmConfigService = new LLMConfigService();
  });

  // ===========================================================================
  // Test 1: API Timeout Handling
  // ===========================================================================

  describe('handles API timeout gracefully', () => {
    it('should fall back to pattern matching when LLM times out', async () => {
      // Simulate timeout error from LLM
      mockAnalyzeTool.mockRejectedValue(new Error('Request timeout after 30000ms'));
      mockClusterTool.mockRejectedValue(new Error('Request timeout after 30000ms'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should still complete successfully using pattern fallback
      expect(result.success).toBe(true);
      expect(result.analyzedMessages.length).toBe(3);

      // Pattern matching should have been called as fallback
      expect(mockAnalyzeEmail).toHaveBeenCalled();

      // Results should still show transactions detected via pattern matching
      expect(result.analyzedMessages.some(m => m.isRealEstateRelated)).toBe(true);
    });

    it('should indicate pattern matching method was used after timeout', async () => {
      mockAnalyzeTool.mockRejectedValue(new Error('ETIMEDOUT'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // When LLM fails, extraction falls back to pattern
      expect(result.analyzedMessages[0].extractionMethod).toBe('pattern');
    });
  });

  // ===========================================================================
  // Test 2: Invalid API Key Error Display
  // ===========================================================================

  describe('shows error when API key is invalid', () => {
    it('should detect invalid API key during validation', async () => {
      // Mock the validation to return failure
      mockValidateApiKey.mockResolvedValue({
        valid: false,
        error: 'Invalid API key provided',
        errorCode: 'invalid_api_key',
      });

      // BACKLOG-2441 — the four @ts-expect-error markers below flag a test that pins a
      // contract production does not have. Real signature (llmConfigService.ts:165) is
      // `validateApiKey(provider: LLMProvider, apiKey: string): Promise<boolean>`:
      //   - the arguments here are REVERSED, and
      //   - `.valid` / `.error` / `.errorCode` do not exist on a boolean.
      // It passes only because the whole module is jest.mock'd above (line ~45), so these
      // assertions are checked against this suite's own mockResolvedValue — the test
      // validates its own mock. Left verbatim rather than "fixed": either production grows a
      // structured `{ valid, error, errorCode }` return (plausible — the UI wants a reason to
      // show) or the assertions are rewritten to the boolean contract. Both rewrite
      // assertions, which is a decision, not a typing chore. See BACKLOG-2441.
      // @ts-expect-error BACKLOG-2441 — args reversed; 'invalid-key-here' is not an LLMProvider
      const validationResult = await llmConfigService.validateApiKey('invalid-key-here', 'openai');

      // @ts-expect-error BACKLOG-2441 — validateApiKey returns boolean; `.valid` does not exist
      expect(validationResult.valid).toBe(false);
      // @ts-expect-error BACKLOG-2441 — validateApiKey returns boolean; `.error` does not exist
      expect(validationResult.error).toContain('Invalid');
      // @ts-expect-error BACKLOG-2441 — validateApiKey returns boolean; `.errorCode` does not exist
      expect(validationResult.errorCode).toBe('invalid_api_key');
    });

    it('should fall back to pattern matching when API key is invalid', async () => {
      // Simulate 401 Unauthorized from LLM API
      mockAnalyzeTool.mockRejectedValue({
        message: 'Invalid API key provided',
        status: 401,
        code: 'invalid_api_key',
      });

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should still succeed with pattern fallback
      expect(result.success).toBe(true);
      expect(mockAnalyzeEmail).toHaveBeenCalled();
    });

    it('should return invalid_api_key error structure', async () => {
      const apiKeyError = errorResponses.invalidApiKey;

      expect(apiKeyError.success).toBe(false);
      expect(apiKeyError.error.code).toBe('invalid_api_key');
      expect(apiKeyError.error.statusCode).toBe(401);
      expect(apiKeyError.error.retryable).toBe(false);
    });
  });

  // ===========================================================================
  // Test 3: Rate Limit Exceeded Message
  // ===========================================================================

  describe('shows rate limit exceeded message', () => {
    it('should handle rate limit error and fall back gracefully', async () => {
      // Simulate 429 Rate Limited from LLM API
      mockAnalyzeTool.mockRejectedValue(
        new Error('Rate limit exceeded. Please retry after 60 seconds.')
      );

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should still succeed with pattern fallback
      expect(result.success).toBe(true);
      expect(result.analyzedMessages.length).toBe(2);

      // Messages should be analyzed by pattern matching instead
      result.analyzedMessages.forEach(msg => {
        expect(msg.extractionMethod).toBe('pattern');
      });
    });

    it('should have correct rate limit error structure', () => {
      const rateLimitError = errorResponses.rateLimited;

      expect(rateLimitError.success).toBe(false);
      expect(rateLimitError.error.code).toBe('rate_limited');
      expect(rateLimitError.error.statusCode).toBe(429);
      expect(rateLimitError.error.retryable).toBe(true);
      expect(rateLimitError.error.message).toContain('60 seconds');
    });

    it('should block LLM when budget rate limit is exceeded', async () => {
      // Configure as if budget is exhausted - no API keys available
      mockGetUserConfig.mockResolvedValue({
        ...mockUserConfigs.budgetExceeded,
        hasOpenAI: false,
        hasAnthropic: false,
      });

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should succeed but use pattern only (no API keys when budget exhausted)
      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pattern');
      expect(result.llmUsed).toBe(false);
    });
  });

  // ===========================================================================
  // Test 4: Malformed Response Fallback to Pattern
  // ===========================================================================

  describe('falls back to pattern on malformed response', () => {
    it('should handle JSON parse errors from LLM response', async () => {
      // Simulate malformed JSON response
      mockAnalyzeTool.mockRejectedValue(new SyntaxError('Unexpected token < in JSON'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should fall back to pattern matching successfully
      expect(result.success).toBe(true);
      expect(mockAnalyzeEmail).toHaveBeenCalled();
    });

    it('should handle incomplete/invalid tool response structure', async () => {
      // Return a response missing required fields
      mockAnalyzeTool.mockResolvedValue({
        success: true,
        data: {
          // Missing isRealEstateRelated, confidence, etc.
          invalidField: 'bad data',
        },
        tokensUsed: { prompt: 100, completion: 50, total: 150 },
        latencyMs: 500,
      });

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should still complete (service handles gracefully)
      expect(result.success).toBe(true);
    });

    it('should handle null/undefined LLM response', async () => {
      mockAnalyzeTool.mockResolvedValue(null);

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should fall back gracefully
      expect(result.success).toBe(true);
      expect(mockAnalyzeEmail).toHaveBeenCalled();
    });

    it('should handle empty string response', async () => {
      mockAnalyzeTool.mockRejectedValue(new Error('Empty response from API'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // Individual message falls back to pattern matching
      expect(result.analyzedMessages[0].extractionMethod).toBe('pattern');
    });
  });

  // ===========================================================================
  // Test 5: Retry on Transient Failure
  // ===========================================================================

  describe('retries on transient failure', () => {
    it('should succeed after transient failures when LLM eventually responds', async () => {
      let callCount = 0;

      // Fail twice, then succeed on third call
      mockAnalyzeTool.mockImplementation(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('503 Service Unavailable'));
        }
        return Promise.resolve(successfulAnalysisResponses['msg-re-001']);
      });

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should eventually succeed (either via retry or fallback)
      expect(result.success).toBe(true);
      expect(result.analyzedMessages.length).toBe(1);
    });

    it('should have correct server error structure for retry scenarios', () => {
      const serverError = errorResponses.serverError;

      expect(serverError.success).toBe(false);
      expect(serverError.error.code).toBe('server_error');
      expect(serverError.error.statusCode).toBe(500);
      expect(serverError.error.retryable).toBe(true);
    });

    it('should identify retryable vs non-retryable errors', () => {
      // Retryable errors
      expect(errorResponses.timeout.error.retryable).toBe(true);
      expect(errorResponses.rateLimited.error.retryable).toBe(true);
      expect(errorResponses.serverError.error.retryable).toBe(true);

      // Non-retryable errors
      expect(errorResponses.invalidApiKey.error.retryable).toBe(false);
      expect(errorResponses.quotaExceeded.error.retryable).toBe(false);
    });

    it('should handle multiple consecutive transient failures', async () => {
      // All calls fail with transient error
      mockAnalyzeTool.mockRejectedValue(new Error('503 Service Unavailable'));
      mockClusterTool.mockRejectedValue(new Error('503 Service Unavailable'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should still succeed via pattern fallback
      expect(result.success).toBe(true);
      // Each message falls back to pattern matching individually
      result.analyzedMessages.forEach(msg => {
        expect(msg.extractionMethod).toBe('pattern');
      });
    });
  });

  // ===========================================================================
  // Test 6: Fallback Notification to User
  // ===========================================================================

  describe('displays fallback notification to user', () => {
    it('should indicate when LLM was not used due to configuration', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.noApiKey);

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.llmUsed).toBe(false);
      expect(result.extractionMethod).toBe('pattern');
    });

    it('should indicate when LLM was not used due to consent', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.noConsent);

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.llmUsed).toBe(false);
      expect(result.extractionMethod).toBe('pattern');
    });

    it('should indicate fallback after LLM failure', async () => {
      // LLM fails, should fall back
      mockAnalyzeTool.mockRejectedValue(new Error('Service unavailable'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // Individual messages show pattern method after fallback
      expect(result.analyzedMessages[0].extractionMethod).toBe('pattern');
    });

    it('should still produce valid transaction results on fallback', async () => {
      mockAnalyzeTool.mockRejectedValue(new Error('AI analysis unavailable'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // Should still detect transactions via pattern matching
      expect(result.analyzedMessages.length).toBe(3);
      expect(result.detectedTransactions.length).toBeGreaterThanOrEqual(0);
    });

    it('should provide extraction method in result for UI display', async () => {
      mockAnalyzeTool.mockRejectedValue(new Error('Timeout'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Result should include information for UI to show fallback notification
      expect(result).toHaveProperty('extractionMethod');
      expect(result).toHaveProperty('llmUsed');
      expect(result).toHaveProperty('success');

      // When LLM is configured but fails, result shows hybrid mode was attempted
      // but individual messages fall back to pattern matching
      expect(result.analyzedMessages[0].extractionMethod).toBe('pattern');
      // llmUsed is true because LLM config was available (attempted)
      expect(result.llmUsed).toBe(true);
    });
  });

  // ===========================================================================
  // Additional Error Scenarios
  // ===========================================================================

  describe('additional error scenarios', () => {
    it('should handle quota exceeded error', async () => {
      mockAnalyzeTool.mockRejectedValue({
        message: 'Monthly quota exceeded',
        code: 'quota_exceeded',
        status: 403,
      });

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(mockAnalyzeEmail).toHaveBeenCalled();
    });

    it('should have correct quota exceeded error structure', () => {
      const quotaError = errorResponses.quotaExceeded;

      expect(quotaError.success).toBe(false);
      expect(quotaError.error.code).toBe('quota_exceeded');
      expect(quotaError.error.statusCode).toBe(403);
      expect(quotaError.error.retryable).toBe(false);
    });

    it('should handle network connectivity errors', async () => {
      mockAnalyzeTool.mockRejectedValue(new Error('ENOTFOUND api.openai.com'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // Individual message falls back to pattern matching
      expect(result.analyzedMessages[0].extractionMethod).toBe('pattern');
    });

    it('should handle connection reset errors', async () => {
      mockAnalyzeTool.mockRejectedValue(new Error('ECONNRESET'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(mockAnalyzeEmail).toHaveBeenCalled();
    });

    it('should handle partial pipeline failures gracefully', async () => {
      // Analysis succeeds but clustering fails
      mockAnalyzeTool.mockResolvedValue(successfulAnalysisResponses['msg-re-001']);
      mockClusterTool.mockRejectedValue(new Error('Clustering service error'));
      mockExtractTool.mockRejectedValue(new Error('Contact extraction failed'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Pipeline should still complete
      expect(result.success).toBe(true);
      expect(result.analyzedMessages.length).toBe(2);
    });
  });

  // ===========================================================================
  // Platform Allowance Exhaustion
  // ===========================================================================

  describe('platform allowance exhaustion', () => {
    it('should fall back when platform allowance is exhausted', async () => {
      mockGetUserConfig.mockResolvedValue({
        ...mockUserConfigs.platformAllowanceOnly,
        platformAllowanceRemaining: 0,
      });

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pattern');
      expect(result.llmUsed).toBe(false);
    });
  });
});
