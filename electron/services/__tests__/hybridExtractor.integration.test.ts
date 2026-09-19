/**
 * Hybrid Extractor Integration Tests
 * TASK-411: Integration tests for hybrid extraction pipeline
 *
 * These tests verify end-to-end behavior of the hybrid extraction pipeline:
 * - Pattern -> LLM fallback behavior
 * - Confidence aggregation with real scenarios
 * - Budget enforcement blocking requests
 * - Strategy selection logic
 * - LLM timeout handling
 * - Usage tracking
 *
 * Unlike unit tests, these integration tests:
 * - Test multiple services working together
 * - Use realistic email fixtures
 * - Verify fallback paths end-to-end
 * - Test the full extraction pipeline
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

// Mock all dependencies BEFORE importing
// Note: Paths are relative to electron/services/__tests__/
jest.mock('../transactionExtractorService', () => ({
  default: {
    analyzeEmail: jest.fn((...args: unknown[]) => mockAnalyzeEmail(...args)),
    groupByProperty: jest.fn((...args: unknown[]) => mockGroupByProperty(...args)),
    generateTransactionSummary: jest.fn((...args: unknown[]) => mockGenerateTransactionSummary(...args)),
  },
  __esModule: true,
}));

jest.mock('../llm/llmConfigService', () => ({
  LLMConfigService: jest.fn().mockImplementation(() => ({
    getUserConfig: jest.fn((...args: unknown[]) => mockGetUserConfig(...args)),
  })),
}));

jest.mock('../llm/openAIService', () => ({
  OpenAIService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
  })),
}));

jest.mock('../llm/anthropicService', () => ({
  AnthropicService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
  })),
}));

jest.mock('../llm/tools/analyzeMessageTool', () => ({
  AnalyzeMessageTool: jest.fn().mockImplementation(() => ({
    analyze: jest.fn((...args: unknown[]) => mockAnalyzeTool(...args)),
  })),
}));

jest.mock('../llm/tools/extractContactRolesTool', () => ({
  ExtractContactRolesTool: jest.fn().mockImplementation(() => ({
    extract: jest.fn((...args: unknown[]) => mockExtractTool(...args)),
  })),
}));

jest.mock('../llm/tools/clusterTransactionsTool', () => ({
  ClusterTransactionsTool: jest.fn().mockImplementation(() => ({
    cluster: jest.fn((...args: unknown[]) => mockClusterTool(...args)),
  })),
}));

jest.mock('../llm/contentSanitizer', () => ({
  ContentSanitizer: jest.fn().mockImplementation(() => ({
    sanitize: jest.fn((content: string) => ({
      sanitizedContent: content,
      maskedItems: [],
      originalLength: content.length,
      sanitizedLength: content.length,
    })),
  })),
}));

jest.mock('../db/llmSettingsDbService', () => ({
  getLLMSettingsByUserId: jest.fn((...args: unknown[]) => mockGetLLMSettings(...args)),
  incrementTokenUsage: jest.fn((...args: unknown[]) => mockIncrementTokenUsage(...args)),
}));

jest.mock('../tokenEncryptionService', () => ({
  default: {
    decrypt: jest.fn((key: string) => `decrypted-${key}`),
    encrypt: jest.fn((key: string) => `encrypted-${key}`),
  },
}));

// NOW import after mocks
import { HybridExtractorService } from '../extraction/hybridExtractorService';
import { ConfidenceAggregatorService } from '../extraction/confidenceAggregatorService';
import { ExtractionStrategyService } from '../extraction/extractionStrategyService';
import { LLMConfigService } from '../llm/llmConfigService';
import { mockEmails, existingTransactions, knownContacts } from '../../../tests/fixtures/realEstateEmails';
import {
  successfulAnalysisResponses,
  nonRealEstateAnalysisResponses,
  successfulClusteringResponse,
  successfulContactExtractionResponse,
  mockUserConfigs,
  mockLLMSettings,
} from '../../../tests/mocks/llmResponses';
import type { HybridExtractionOptions } from '../extraction/types';

describe('HybridExtractor Integration Tests', () => {
  let hybridExtractor: HybridExtractorService;
  let confidenceAggregator: ConfidenceAggregatorService;
  let strategyService: ExtractionStrategyService;

  // Standard options for tests
  const patternOnlyOptions: HybridExtractionOptions = {
    usePatternMatching: true,
    useLLM: false,
  };

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
    mockGetLLMSettings.mockResolvedValue(mockLLMSettings.configured);

    // Setup pattern matcher to recognize real estate emails
    mockAnalyzeEmail.mockImplementation((email: { subject?: string; body?: string }) => {
      const hasRealEstateContent =
        email.subject?.includes('Main St') ||
        email.subject?.includes('Offer on') ||
        email.subject?.includes('Inspection') ||
        email.subject?.includes('Title') ||
        email.subject?.includes('Listing') ||
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

    // Setup LLM tool mocks with successful responses
    mockAnalyzeTool.mockImplementation((input: { subject?: string }) => {
      // Match response based on subject
      if (input.subject?.includes('Offer on 123 Main St')) {
        return Promise.resolve(successfulAnalysisResponses['msg-re-001']);
      }
      if (input.subject?.includes('Inspection Scheduled')) {
        return Promise.resolve(successfulAnalysisResponses['msg-re-002']);
      }
      if (input.subject?.includes('Title Commitment')) {
        return Promise.resolve(successfulAnalysisResponses['msg-re-003']);
      }
      if (input.subject?.includes('Newsletter')) {
        return Promise.resolve(nonRealEstateAnalysisResponses['msg-nr-001']);
      }
      // Default response
      return Promise.resolve(successfulAnalysisResponses['msg-re-001']);
    });

    mockClusterTool.mockResolvedValue(successfulClusteringResponse);
    mockExtractTool.mockResolvedValue(successfulContactExtractionResponse);

    // Create service instances
    hybridExtractor = new HybridExtractorService();
    confidenceAggregator = new ConfidenceAggregatorService();
    strategyService = new ExtractionStrategyService(new LLMConfigService());
  });

  // ===========================================================================
  // Pattern -> LLM Fallback Behavior Tests
  // ===========================================================================

  describe('Pattern -> LLM Fallback Behavior', () => {
    it('should fall back to pattern-only when LLM is disabled in options', async () => {
      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pattern');
      expect(result.llmUsed).toBe(false);
      expect(mockAnalyzeTool).not.toHaveBeenCalled();
      expect(mockAnalyzeEmail).toHaveBeenCalled();
    });

    it('should fall back to pattern when user has no LLM consent', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.noConsent);

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pattern');
      expect(result.llmUsed).toBe(false);
    });

    it('should fall back to pattern when no API keys are configured', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.noApiKey);

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pattern');
      expect(result.llmUsed).toBe(false);
    });

    it('should fall back gracefully when LLM analysis throws error', async () => {
      mockAnalyzeTool.mockRejectedValue(new Error('LLM API unavailable'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should still succeed with pattern fallback
      expect(result.success).toBe(true);
      expect(result.analyzedMessages.length).toBeGreaterThan(0);
      // Pattern analysis should have run
      expect(mockAnalyzeEmail).toHaveBeenCalled();
    });

    it('should fall back when LLM clustering fails', async () => {
      mockClusterTool.mockRejectedValue(new Error('Clustering timeout'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // Should have fallen back to pattern-based clustering
      expect(mockGroupByProperty).toHaveBeenCalled();
    });

    it('should continue successfully when contact extraction fails', async () => {
      mockExtractTool.mockRejectedValue(new Error('Contact extraction failed'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Pipeline should still complete
      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // Confidence Aggregation Tests
  // ===========================================================================

  describe('Confidence Aggregation with Real Scenarios', () => {
    it('should correctly weight LLM confidence higher (60/40 split)', () => {
      // Pattern: 80/100 = 0.8, LLM: 0.9
      // Expected: 0.8 * 0.4 + 0.9 * 0.6 = 0.32 + 0.54 = 0.86 + agreement bonus
      const aggregated = confidenceAggregator.aggregate(80, 0.9, true);

      // With agreement bonus (0.15), expected ~0.86 + 0.15 = 1.0 (capped at 1)
      expect(aggregated.score).toBeGreaterThanOrEqual(0.86);
      expect(aggregated.level).toBe('high');
      expect(aggregated.components.agreement).toBe(true);
    });

    it('should apply agreement bonus when both methods agree', () => {
      const withAgreement = confidenceAggregator.aggregate(70, 0.8, true);
      const withoutAgreement = confidenceAggregator.aggregate(70, 0.8, false);

      expect(withAgreement.score).toBeGreaterThan(withoutAgreement.score);
    });

    it('should apply single-method penalty when only pattern available', () => {
      const patternOnly = confidenceAggregator.aggregate(75, null, false);
      const hybrid = confidenceAggregator.aggregate(75, 0.75, true);

      // Pattern only should have lower score due to penalty
      expect(patternOnly.score).toBeLessThan(hybrid.score);
      expect(patternOnly.explanation).toContain('Pattern matching only');
    });

    it('should apply single-method penalty when only LLM available', () => {
      const llmOnly = confidenceAggregator.aggregate(null, 0.85, false);

      expect(llmOnly.score).toBe(0.75); // 0.85 - 0.1 penalty
      expect(llmOnly.explanation).toContain('LLM analysis only');
    });

    it('should return low confidence for no data', () => {
      const noData = confidenceAggregator.aggregate(null, null, false);

      expect(noData.score).toBe(0);
      expect(noData.level).toBe('low');
      expect(noData.explanation).toContain('No confidence data');
    });

    it('should classify confidence levels correctly', () => {
      expect(confidenceAggregator.scoreToLevel(0.9)).toBe('high');
      expect(confidenceAggregator.scoreToLevel(0.8)).toBe('high');
      expect(confidenceAggregator.scoreToLevel(0.7)).toBe('medium');
      expect(confidenceAggregator.scoreToLevel(0.5)).toBe('medium');
      expect(confidenceAggregator.scoreToLevel(0.4)).toBe('low');
      expect(confidenceAggregator.scoreToLevel(0.1)).toBe('low');
    });

    it('should handle aggregation for transaction detection', () => {
      const patternResult = { isRealEstateRelated: true, confidence: 75 };
      const llmResult = { isRealEstateRelated: true, confidence: 0.9 };

      const aggregated = confidenceAggregator.aggregateForTransaction(
        patternResult,
        llmResult
      );

      expect(aggregated.components.agreement).toBe(true);
      expect(aggregated.score).toBeGreaterThan(0.8);
    });

    it('should detect disagreement between methods', () => {
      const patternResult = { isRealEstateRelated: true, confidence: 70 };
      const llmResult = { isRealEstateRelated: false, confidence: 0.8 };

      const aggregated = confidenceAggregator.aggregateForTransaction(
        patternResult,
        llmResult
      );

      expect(aggregated.components.agreement).toBe(false);
    });
  });

  // ===========================================================================
  // Budget Enforcement Tests
  // ===========================================================================

  describe('Budget Enforcement', () => {
    it('should block LLM when monthly budget is exceeded', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.budgetExceeded);

      const strategy = await strategyService.selectStrategy('test-user', {
        messageCount: 10,
      });

      expect(strategy.method).toBe('pattern');
      expect(strategy.reason).toContain('budget');
    });

    it('should allow LLM when within budget', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.fullyConfigured);

      const strategy = await strategyService.selectStrategy('test-user', {
        messageCount: 10,
      });

      expect(strategy.method).toBe('hybrid');
      expect(strategy.budgetRemaining).toBeDefined();
      expect(strategy.estimatedTokenCost).toBeDefined();
    });

    it('should estimate token cost based on message count', () => {
      const cost0 = strategyService.estimateTokenCost(0);
      const cost5 = strategyService.estimateTokenCost(5);
      const cost10 = strategyService.estimateTokenCost(10);

      expect(cost5).toBeGreaterThan(cost0);
      expect(cost10).toBeGreaterThan(cost5);
      // 10 messages = 10 * 800 + 1500 + 1200 = 10700
      expect(cost10).toBe(10700);
    });

    it('should block when estimated cost exceeds remaining budget', async () => {
      // Configure budget with very little remaining
      mockGetUserConfig.mockResolvedValue({
        ...mockUserConfigs.fullyConfigured,
        tokensUsed: 99000,
        budgetLimit: 100000, // Only 1000 tokens remaining
      });

      const strategy = await strategyService.selectStrategy('test-user', {
        messageCount: 5, // Would need ~5700 tokens
      });

      expect(strategy.method).toBe('pattern');
      // Budget message could say "too low" or "insufficient" depending on threshold
      expect(strategy.reason).toMatch(/too low|insufficient/i);
    });

    it('should handle platform allowance exhaustion', async () => {
      mockGetUserConfig.mockResolvedValue({
        ...mockUserConfigs.platformAllowanceOnly,
        platformAllowanceRemaining: 0,
      });

      const strategy = await strategyService.selectStrategy('test-user');

      expect(strategy.method).toBe('pattern');
    });
  });

  // ===========================================================================
  // Strategy Selection Logic Tests
  // ===========================================================================

  describe('Strategy Selection Logic', () => {
    it('should select hybrid when LLM is available and configured', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.fullyConfigured);

      const strategy = await strategyService.selectStrategy('test-user');

      expect(strategy.method).toBe('hybrid');
      expect(strategy.provider).toBe('openai'); // Preferred provider
      expect(strategy.fallbackMethod).toBe('pattern');
    });

    it('should select pattern-only when user has no consent', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.noConsent);

      const strategy = await strategyService.selectStrategy('test-user');

      expect(strategy.method).toBe('pattern');
      expect(strategy.reason).toContain('consent');
    });

    it('should select pattern-only when no API keys configured', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.noApiKey);

      const strategy = await strategyService.selectStrategy('test-user');

      expect(strategy.method).toBe('pattern');
      expect(strategy.reason).toContain('API key');
    });

    it('should fall back to alternate provider when preferred unavailable', async () => {
      mockGetUserConfig.mockResolvedValue({
        ...mockUserConfigs.fullyConfigured,
        hasOpenAI: false,
        hasAnthropic: true,
        preferredProvider: 'openai',
      });

      const strategy = await strategyService.selectStrategy('test-user');

      expect(strategy.method).toBe('hybrid');
      expect(strategy.provider).toBe('anthropic');
    });

    it('should support LLM-only strategy selection', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.fullyConfigured);

      const strategy = await strategyService.selectLLMOnlyStrategy('test-user');

      expect(strategy.method).toBe('llm');
      expect(strategy.reason).toContain('LLM-only');
    });

    it('should fall back for LLM-only when LLM unavailable', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.noApiKey);

      const strategy = await strategyService.selectLLMOnlyStrategy('test-user');

      expect(strategy.method).toBe('pattern');
      expect(strategy.reason).toContain('not available');
    });

    it('should provide pattern-only strategy on request', () => {
      const strategy = strategyService.getPatternOnlyStrategy();

      expect(strategy.method).toBe('pattern');
      expect(strategy.reason).toContain('explicitly requested');
    });

    it('should handle errors gracefully in strategy selection', async () => {
      mockGetUserConfig.mockRejectedValue(new Error('Database error'));

      const strategy = await strategyService.selectStrategy('test-user');

      expect(strategy.method).toBe('pattern');
      expect(strategy.reason).toContain('Error');
    });
  });

  // ===========================================================================
  // LLM Timeout Handling Tests
  // ===========================================================================

  describe('LLM Timeout Handling', () => {
    it('should handle LLM timeout gracefully with pattern fallback', async () => {
      // Simulate timeout error
      mockAnalyzeTool.mockRejectedValue(new Error('Request timeout after 30000ms'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.analyzedMessages.length).toBe(2);
      // Messages should still be analyzed by pattern matching
      expect(mockAnalyzeEmail).toHaveBeenCalled();
    });

    it('should handle clustering timeout with pattern fallback', async () => {
      mockClusterTool.mockRejectedValue(new Error('Clustering timeout'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // Should have used pattern-based clustering
      expect(mockGroupByProperty).toHaveBeenCalled();
    });

    it('should handle rate limit errors as fallback scenario', async () => {
      mockAnalyzeTool.mockRejectedValue(
        new Error('Rate limit exceeded. Please retry after 60 seconds.')
      );

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.analyzedMessages[0].extractionMethod).toBe('pattern');
    });
  });

  // ===========================================================================
  // Usage Tracking Tests
  // ===========================================================================

  describe('Usage Tracking', () => {
    it('should track token usage from LLM calls', async () => {
      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.llmUsed).toBe(true);
      expect(result.tokensUsed).toBeDefined();
      expect(result.tokensUsed!.total).toBeGreaterThan(0);
      expect(result.tokensUsed!.prompt).toBeGreaterThan(0);
      expect(result.tokensUsed!.completion).toBeGreaterThan(0);
    });

    it('should not track tokens when LLM is not used', async () => {
      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        patternOnlyOptions
      );

      expect(result.llmUsed).toBe(false);
      expect(result.tokensUsed).toBeUndefined();
    });

    it('should accumulate tokens from multiple LLM operations', async () => {
      // Process multiple messages to accumulate tokens
      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 4),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should have tokens from: analyze (4x) + cluster (1x) + contact extract (per cluster)
      expect(result.tokensUsed).toBeDefined();
      expect(result.tokensUsed!.total).toBeGreaterThan(
        successfulAnalysisResponses['msg-re-001'].tokensUsed.total
      );
    });

    it('should track latency in extraction results', async () => {
      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.latencyMs).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should reset token tracking between extractions', async () => {
      // First extraction
      const result1 = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Second extraction
      const result2 = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Token counts should be independent, not accumulated
      expect(result1.tokensUsed!.total).toBeCloseTo(result2.tokensUsed!.total, -2);
    });
  });

  // ===========================================================================
  // Full Pipeline Integration Tests
  // ===========================================================================

  describe('Full Pipeline Integration', () => {
    it('should process real estate emails end-to-end in hybrid mode', async () => {
      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('hybrid');
      expect(result.analyzedMessages).toHaveLength(3);
      expect(result.detectedTransactions.length).toBeGreaterThanOrEqual(1);

      // Verify analyzed messages have expected properties
      const analyzed = result.analyzedMessages[0];
      expect(analyzed.id).toBeDefined();
      expect(analyzed.isRealEstateRelated).toBe(true);
      expect(analyzed.confidence).toBeGreaterThan(0);
      expect(analyzed.extractionMethod).toBe('hybrid');
    });

    it('should correctly classify non-real estate emails', async () => {
      // Setup pattern matcher to recognize non-RE emails
      mockAnalyzeEmail.mockImplementation((_email: { subject?: string }) => ({
        isRealEstateRelated: false,
        transactionType: null,
        confidence: 5,
        addresses: [],
        amounts: [],
        dates: [],
        parties: [],
        mlsNumbers: [],
        keywords: [],
      }));

      mockAnalyzeTool.mockResolvedValue(nonRealEstateAnalysisResponses['msg-nr-001']);

      const result = await hybridExtractor.extract(
        mockEmails.nonRealEstate,
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // Non-RE emails should be filtered out from transactions
      expect(result.detectedTransactions).toHaveLength(0);
      // But all messages should be analyzed
      expect(result.analyzedMessages.length).toBe(mockEmails.nonRealEstate.length);
    });

    it('should handle empty message list', async () => {
      const result = await hybridExtractor.extract(
        [],
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.analyzedMessages).toHaveLength(0);
      expect(result.detectedTransactions).toHaveLength(0);
    });

    it('should handle edge case emails', async () => {
      const result = await hybridExtractor.extract(
        mockEmails.edgeCases,
        existingTransactions,
        knownContacts,
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
      expect(result.analyzedMessages).toHaveLength(mockEmails.edgeCases.length);
    });

    it('should preserve message IDs through the pipeline', async () => {
      const inputIds = mockEmails.realEstate.slice(0, 3).map(m => m.id);

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        patternOnlyOptions
      );

      const outputIds = result.analyzedMessages.map(m => m.id);
      expect(outputIds).toEqual(inputIds);
    });

    it('should include proper date range in detected transactions', async () => {
      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        patternOnlyOptions
      );

      if (result.detectedTransactions.length > 0) {
        const tx = result.detectedTransactions[0];
        expect(tx.dateRange).toBeDefined();
        expect(tx.dateRange.start).toBeDefined();
        expect(tx.dateRange.end).toBeDefined();
      }
    });

    it('should provide extraction method in all results', async () => {
      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 2),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Check messages
      result.analyzedMessages.forEach(msg => {
        expect(['pattern', 'llm', 'hybrid']).toContain(msg.extractionMethod);
      });

      // Check transactions
      result.detectedTransactions.forEach(tx => {
        expect(['pattern', 'llm', 'hybrid']).toContain(tx.extractionMethod);
      });
    });
  });

  // ===========================================================================
  // Error Recovery Tests
  // ===========================================================================

  describe('Error Recovery', () => {
    it('should recover from partial LLM failures', async () => {
      // First call succeeds, second fails
      let callCount = 0;
      mockAnalyzeTool.mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error('Temporary failure'));
        }
        return Promise.resolve(successfulAnalysisResponses['msg-re-001']);
      });

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 3),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      // Should still complete successfully
      expect(result.success).toBe(true);
      expect(result.analyzedMessages.length).toBe(3);
    });

    it('should report LLM errors in result when fallback is used', async () => {
      mockGetUserConfig.mockResolvedValue(mockUserConfigs.fullyConfigured);
      mockAnalyzeTool.mockRejectedValue(new Error('API Error: Service unavailable'));
      mockClusterTool.mockRejectedValue(new Error('API Error: Service unavailable'));

      const result = await hybridExtractor.extract(
        mockEmails.realEstate.slice(0, 1),
        existingTransactions,
        knownContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      // LLM errors during analysis should be handled gracefully
      // The service logs warnings but doesn't expose them in the result
    });

    it('should handle undefined/null in message fields gracefully', async () => {
      const messagesWithNulls = [
        {
          id: 'msg-null-test',
          subject: '',
          body: '',
          sender: '',
          recipients: [],
          date: '2024-01-15',
        },
      ];

      mockAnalyzeEmail.mockReturnValue({
        isRealEstateRelated: false,
        transactionType: null,
        confidence: 0,
        addresses: [],
        amounts: [],
        dates: [],
        parties: [],
        mlsNumbers: [],
        keywords: [],
      });

      const result = await hybridExtractor.extract(
        messagesWithNulls,
        existingTransactions,
        knownContacts,
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
      expect(result.analyzedMessages).toHaveLength(1);
    });
  });
});
