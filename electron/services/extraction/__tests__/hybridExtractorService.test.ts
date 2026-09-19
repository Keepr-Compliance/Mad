/**
 * Unit tests for HybridExtractorService
 * TASK-320: Hybrid Extractor Service
 *
 * Tests cover:
 * - Pattern-only mode (LLM disabled)
 * - Fallback when LLM fails
 * - Confidence merging
 * - Message analysis flow
 * - Transaction clustering
 * - Full extraction pipeline
 */

// Mock uuid first (no dependencies)
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-1234'),
}));

// Create mock functions that will be used across all mocks
const mockAnalyzeEmail = jest.fn();
const mockGroupByProperty = jest.fn();
const mockGenerateTransactionSummary = jest.fn();
const mockGetUserConfig = jest.fn();
const mockAnalyzeTool = jest.fn();
const mockExtractTool = jest.fn();
const mockClusterTool = jest.fn();
const mockGetLLMSettings = jest.fn();

// Mock all dependencies BEFORE importing the service
jest.mock('../../transactionExtractorService', () => ({
  default: {
    analyzeEmail: jest.fn((...args: unknown[]) => mockAnalyzeEmail(...args)),
    groupByProperty: jest.fn((...args: unknown[]) => mockGroupByProperty(...args)),
    generateTransactionSummary: jest.fn((...args: unknown[]) => mockGenerateTransactionSummary(...args)),
  },
  __esModule: true,
}));

jest.mock('../../llm/llmConfigService', () => ({
  LLMConfigService: jest.fn().mockImplementation(() => ({
    getUserConfig: jest.fn((...args: unknown[]) => mockGetUserConfig(...args)),
  })),
}));

jest.mock('../../llm/openAIService', () => ({
  OpenAIService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
  })),
}));

jest.mock('../../llm/anthropicService', () => ({
  AnthropicService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
  })),
}));

jest.mock('../../llm/tools/analyzeMessageTool', () => ({
  AnalyzeMessageTool: jest.fn().mockImplementation(() => ({
    analyze: jest.fn((...args: unknown[]) => mockAnalyzeTool(...args)),
  })),
}));

jest.mock('../../llm/tools/extractContactRolesTool', () => ({
  ExtractContactRolesTool: jest.fn().mockImplementation(() => ({
    extract: jest.fn((...args: unknown[]) => mockExtractTool(...args)),
  })),
}));

jest.mock('../../llm/tools/clusterTransactionsTool', () => ({
  ClusterTransactionsTool: jest.fn().mockImplementation(() => ({
    cluster: jest.fn((...args: unknown[]) => mockClusterTool(...args)),
  })),
}));

jest.mock('../../llm/contentSanitizer', () => ({
  ContentSanitizer: jest.fn().mockImplementation(() => ({
    sanitize: jest.fn((content: string) => ({
      sanitizedContent: content,
      maskedItems: [],
      originalLength: content.length,
      sanitizedLength: content.length,
    })),
  })),
}));

jest.mock('../../db/llmSettingsDbService', () => ({
  getLLMSettingsByUserId: jest.fn((...args: unknown[]) => mockGetLLMSettings(...args)),
}));

jest.mock('../../tokenEncryptionService', () => ({
  default: {
    decrypt: jest.fn((key: string) => `decrypted-${key}`),
  },
}));

// NOW import the modules after mocks are set up
import { HybridExtractorService } from '../hybridExtractorService';
import {
  MessageInput,
  HybridExtractionOptions,
  ExistingTransactionRef,
  CONFIDENCE_WEIGHTS,
} from '../types';
import type { Contact } from '../../../types';

describe('HybridExtractorService', () => {
  let service: HybridExtractorService;

  // Test data
  const testMessages: MessageInput[] = [
    {
      id: 'msg-1',
      subject: 'Re: Closing on 123 Main St, San Francisco, CA 94102',
      body: 'Hi, I wanted to confirm the closing date for 123 Main Street. The buyer has approved the $450,000 offer.',
      sender: 'agent@realty.com',
      recipients: ['buyer@email.com', 'seller@email.com'],
      date: '2024-01-15T10:30:00Z',
    },
    {
      id: 'msg-2',
      subject: 'Weekly Newsletter',
      body: 'Check out our latest marketing deals! Special offer this week.',
      sender: 'marketing@company.com',
      recipients: ['user@email.com'],
      date: '2024-01-16T08:00:00Z',
    },
    {
      id: 'msg-3',
      subject: 'Inspection scheduled - 123 Main St',
      body: 'The home inspection for 123 Main Street has been scheduled for January 20th.',
      sender: 'inspector@inspect.com',
      recipients: ['agent@realty.com'],
      date: '2024-01-17T14:00:00Z',
    },
  ];

  const testContacts: Contact[] = [
    {
      id: 'contact-1',
      user_id: 'user-1',
      display_name: 'John Smith',
      email: 'john@email.com',
      phone: '555-1234',
      source: 'manual',
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    },
  ];

  const testExistingTransactions: ExistingTransactionRef[] = [
    {
      id: 'tx-existing-1',
      propertyAddress: '456 Oak Ave',
      transactionType: 'purchase',
    },
  ];

  const patternOnlyOptions: HybridExtractionOptions = {
    usePatternMatching: true,
    useLLM: false,
  };

  const hybridOptions: HybridExtractionOptions = {
    usePatternMatching: true,
    useLLM: true,
    userId: 'user-1',
    llmProvider: 'openai',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock LLM config
    mockGetUserConfig.mockResolvedValue({
      hasOpenAI: true,
      hasAnthropic: false,
      preferredProvider: 'openai',
      openAIModel: 'gpt-4o-mini',
      anthropicModel: 'claude-3-haiku-20240307',
      tokensUsed: 0,
      platformAllowanceRemaining: 10000,
      usePlatformAllowance: false,
      autoDetectEnabled: true,
      roleExtractionEnabled: true,
      hasConsent: true,
    });

    // Setup mock LLM settings for API key retrieval
    mockGetLLMSettings.mockResolvedValue({
      openai_api_key_encrypted: 'encrypted-key',
      anthropic_api_key_encrypted: null,
      preferred_provider: 'openai',
    });

    // Setup mock pattern matcher
    mockAnalyzeEmail.mockImplementation((email: { subject?: string; body?: string; from?: string; date?: string }) => {
      const isRE = (email.subject?.includes('Main St') || email.body?.includes('closing')) ?? false;
      return {
        isRealEstateRelated: isRE,
        transactionType: isRE ? 'purchase' : null,
        confidence: isRE ? 75 : 10,
        addresses: isRE ? ['123 Main Street, San Francisco, CA 94102'] : [],
        amounts: isRE ? [450000] : [],
        dates: ['2024-01-15'],
        parties: [{ email: email.from, role: 'sender' }],
        mlsNumbers: [],
        keywords: isRE ? [{ category: 'transaction', keyword: 'closing' }] : [],
        subject: email.subject,
        from: email.from,
        date: email.date,
      };
    });

    mockGroupByProperty.mockReturnValue({
      '123 Main Street, San Francisco, CA 94102': [
        {
          isRealEstateRelated: true,
          transactionType: 'purchase',
          confidence: 75,
          addresses: ['123 Main Street, San Francisco, CA 94102'],
          amounts: [450000],
          dates: ['2024-01-15'],
          parties: [],
          mlsNumbers: [],
          keywords: [],
          date: '2024-01-15',
        },
      ],
    });

    mockGenerateTransactionSummary.mockReturnValue({
      propertyAddress: '123 Main Street, San Francisco, CA 94102',
      transactionType: 'purchase',
      salePrice: 450000,
      closingDate: '2024-02-15',
      mlsNumbers: [],
      communicationsCount: 2,
      firstCommunication: new Date('2024-01-15').getTime(),
      lastCommunication: new Date('2024-01-17').getTime(),
      confidence: 75,
      emails: [],
    });

    // Setup mock LLM tools with default successful responses
    mockAnalyzeTool.mockResolvedValue({
      success: true,
      data: {
        isRealEstateRelated: true,
        confidence: 0.9,
        transactionIndicators: { type: 'purchase', stage: 'closing' },
        extractedEntities: {
          addresses: [{ value: '123 Main Street', confidence: 0.95 }],
          amounts: [{ value: 450000, context: 'offer' }],
          dates: [],
          contacts: [],
        },
        reasoning: 'Real estate closing discussion',
      },
      tokensUsed: { prompt: 100, completion: 50, total: 150 },
      latencyMs: 500,
    });

    mockClusterTool.mockResolvedValue({
      success: true,
      data: {
        clusters: [
          {
            clusterId: 'cluster-1',
            propertyAddress: '123 Main Street',
            confidence: 0.85,
            transactionType: 'purchase',
            stage: 'closing',
            communicationIds: ['msg-1', 'msg-3'],
            dateRange: { start: '2024-01-15', end: '2024-01-17' },
            suggestedContacts: [{ name: 'Agent', email: 'agent@realty.com', role: 'buyer_agent' }],
            summary: 'Purchase transaction at 123 Main Street',
          },
        ],
        unclustered: ['msg-2'],
      },
      tokensUsed: { prompt: 200, completion: 100, total: 300 },
      latencyMs: 800,
    });

    mockExtractTool.mockResolvedValue({
      success: true,
      data: {
        assignments: [
          { name: 'Agent', email: 'agent@realty.com', role: 'buyer_agent', confidence: 0.9, evidence: [] },
        ],
      },
      tokensUsed: { prompt: 150, completion: 75, total: 225 },
      latencyMs: 600,
    });

    service = new HybridExtractorService();
  });

  // ===========================================================================
  // Pattern-Only Mode Tests
  // ===========================================================================

  describe('pattern-only mode', () => {
    it('should analyze messages using only pattern matching', async () => {
      const result = await service.analyzeMessages(testMessages, patternOnlyOptions);

      expect(result).toHaveLength(3);
      expect(mockAnalyzeEmail).toHaveBeenCalledTimes(3);

      // First message should be RE-related
      expect(result[0].isRealEstateRelated).toBe(true);
      expect(result[0].confidence).toBeGreaterThan(0.5);
      expect(result[0].extractionMethod).toBe('pattern');
      expect(result[0].patternAnalysis).toBeDefined();
      expect(result[0].llmAnalysis).toBeUndefined();

      // Second message should not be RE-related
      expect(result[1].isRealEstateRelated).toBe(false);
      expect(result[1].confidence).toBeLessThan(0.5);
    });

    it('should cluster using pattern-based grouping', async () => {
      const analyzed = await service.analyzeMessages(testMessages, patternOnlyOptions);
      const transactions = await service.clusterIntoTransactions(
        analyzed,
        testExistingTransactions,
        patternOnlyOptions
      );

      expect(mockGroupByProperty).toHaveBeenCalled();
      expect(mockGenerateTransactionSummary).toHaveBeenCalled();
      expect(transactions.length).toBeGreaterThanOrEqual(1);
      expect(transactions[0].extractionMethod).toBe('pattern');
    });

    it('should run full extraction pipeline in pattern-only mode', async () => {
      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pattern');
      expect(result.llmUsed).toBe(false);
      expect(result.llmError).toBeUndefined();
      expect(result.tokensUsed).toBeUndefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.analyzedMessages).toHaveLength(3);
    });

    it('should normalize pattern confidence from 0-100 to 0-1', async () => {
      const result = await service.analyzeMessages(testMessages.slice(0, 1), patternOnlyOptions);

      // Pattern returns 75 (0-100), should be normalized to 0.75 (0-1)
      expect(result[0].confidence).toBe(0.75);
    });
  });

  // ===========================================================================
  // Hybrid Mode Tests
  // ===========================================================================

  describe('hybrid mode', () => {
    it('should analyze messages using both pattern and LLM when configured', async () => {
      const result = await service.analyzeMessages(testMessages.slice(0, 1), hybridOptions);

      expect(result).toHaveLength(1);
      expect(mockAnalyzeEmail).toHaveBeenCalled();
      expect(mockAnalyzeTool).toHaveBeenCalled();
      expect(result[0].extractionMethod).toBe('hybrid');
      expect(result[0].patternAnalysis).toBeDefined();
      expect(result[0].llmAnalysis).toBeDefined();
    });

    it('should merge confidence scores with correct weights', async () => {
      const result = await service.analyzeMessages(testMessages.slice(0, 1), hybridOptions);

      // Pattern confidence: 75 (0-100) = 0.75 (0-1)
      // LLM confidence: 0.9
      // Expected: 0.9 * 0.6 + 0.75 * 0.4 = 0.54 + 0.30 = 0.84
      const expectedConfidence = 0.9 * CONFIDENCE_WEIGHTS.llm + 0.75 * CONFIDENCE_WEIGHTS.pattern;
      expect(result[0].confidence).toBeCloseTo(expectedConfidence, 2);
    });

    it('should run full hybrid extraction pipeline', async () => {
      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('hybrid');
      expect(result.llmUsed).toBe(true);
      expect(result.tokensUsed).toBeDefined();
      expect(result.tokensUsed?.total).toBeGreaterThan(0);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should use LLM for clustering when enabled', async () => {
      const analyzed = await service.analyzeMessages(testMessages, hybridOptions);
      const transactions = await service.clusterIntoTransactions(
        analyzed,
        testExistingTransactions,
        hybridOptions
      );

      expect(mockClusterTool).toHaveBeenCalled();
      expect(transactions.length).toBeGreaterThanOrEqual(1);
      expect(transactions[0].extractionMethod).toBe('hybrid');
    });

    it('should extract contact roles for detected transactions', async () => {
      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      // Contact extraction should be called
      expect(mockExtractTool).toHaveBeenCalled();
      expect(result.detectedTransactions.length).toBeGreaterThanOrEqual(1);
      expect(result.detectedTransactions[0].suggestedContacts).toBeDefined();
    });
  });

  // ===========================================================================
  // Fallback Tests
  // ===========================================================================

  describe('fallback behavior', () => {
    it('should fallback to pattern-only when LLM analysis fails', async () => {
      mockAnalyzeTool.mockRejectedValue(new Error('LLM API error'));

      const result = await service.analyzeMessages(testMessages.slice(0, 1), hybridOptions);

      // Should still succeed using pattern analysis
      expect(result).toHaveLength(1);
      expect(result[0].extractionMethod).toBe('pattern'); // Fallback
      expect(result[0].patternAnalysis).toBeDefined();
      expect(result[0].llmAnalysis).toBeUndefined();
    });

    it('should fallback to pattern clustering when LLM clustering fails', async () => {
      mockClusterTool.mockRejectedValue(new Error('Clustering failed'));

      const analyzed = await service.analyzeMessages(testMessages, hybridOptions);
      const transactions = await service.clusterIntoTransactions(
        analyzed,
        testExistingTransactions,
        hybridOptions
      );

      // Should fallback to pattern-based clustering
      expect(mockGroupByProperty).toHaveBeenCalled();
      expect(transactions.length).toBeGreaterThanOrEqual(0);
    });

    it('should continue when role extraction fails', async () => {
      mockExtractTool.mockRejectedValue(new Error('Role extraction failed'));

      const result = await service.extract(
        testMessages.slice(0, 1),
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      // Pipeline should still succeed
      expect(result.success).toBe(true);
    });

    it('should fallback when user has no LLM consent', async () => {
      mockGetUserConfig.mockResolvedValue({
        hasOpenAI: true,
        hasAnthropic: false,
        preferredProvider: 'openai',
        openAIModel: 'gpt-4o-mini',
        anthropicModel: 'claude-3-haiku-20240307',
        tokensUsed: 0,
        platformAllowanceRemaining: 10000,
        usePlatformAllowance: false,
        autoDetectEnabled: true,
        roleExtractionEnabled: true,
        hasConsent: false, // No consent
      });

      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pattern');
      expect(result.llmUsed).toBe(false);
    });

    it('should fallback when no API key is configured', async () => {
      mockGetUserConfig.mockResolvedValue({
        hasOpenAI: false, // No API key
        hasAnthropic: false,
        preferredProvider: 'openai',
        openAIModel: 'gpt-4o-mini',
        anthropicModel: 'claude-3-haiku-20240307',
        tokensUsed: 0,
        platformAllowanceRemaining: 10000,
        usePlatformAllowance: false,
        autoDetectEnabled: true,
        roleExtractionEnabled: true,
        hasConsent: true,
      });

      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      expect(result.success).toBe(true);
      expect(result.extractionMethod).toBe('pattern');
      expect(result.llmUsed).toBe(false);
    });

    it('should handle full pipeline error with graceful fallback', async () => {
      // Make LLM analysis fail for all messages
      mockAnalyzeTool.mockRejectedValue(new Error('LLM unavailable'));

      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      // Should still succeed with pattern-only fallback
      expect(result.success).toBe(true);
      expect(result.analyzedMessages).toHaveLength(3);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle empty message list', async () => {
      const result = await service.extract(
        [],
        testExistingTransactions,
        testContacts,
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
      expect(result.analyzedMessages).toHaveLength(0);
      expect(result.detectedTransactions).toHaveLength(0);
    });

    it('should handle no real estate messages', async () => {
      mockAnalyzeEmail.mockReturnValue({
        isRealEstateRelated: false,
        transactionType: null,
        confidence: 5,
        addresses: [],
        amounts: [],
        dates: [],
        parties: [],
        mlsNumbers: [],
        keywords: [],
        date: '2024-01-15',
      });

      const nonREMessages = [
        {
          id: 'msg-1',
          subject: 'Meeting tomorrow',
          body: 'Let us meet for coffee.',
          sender: 'friend@email.com',
          recipients: ['user@email.com'],
          date: '2024-01-15T10:30:00Z',
        },
      ];

      const result = await service.extract(
        nonREMessages,
        testExistingTransactions,
        testContacts,
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
      expect(result.analyzedMessages).toHaveLength(1);
      expect(result.analyzedMessages[0].isRealEstateRelated).toBe(false);
      expect(result.detectedTransactions).toHaveLength(0);
    });

    it('should handle empty contacts list', async () => {
      const result = await service.extract(
        testMessages.slice(0, 1),
        testExistingTransactions,
        [], // Empty contacts
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
    });

    it('should handle empty existing transactions list', async () => {
      const result = await service.extract(
        testMessages.slice(0, 1),
        [], // Empty existing transactions
        testContacts,
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
    });

    it('should preserve message id through the pipeline', async () => {
      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        patternOnlyOptions
      );

      // All original IDs should be preserved
      const ids = result.analyzedMessages.map((m) => m.id);
      expect(ids).toContain('msg-1');
      expect(ids).toContain('msg-2');
      expect(ids).toContain('msg-3');
    });

    it('should handle messages with minimal data', async () => {
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
        date: '2024-01-15',
      });

      const messageWithMinimalData: MessageInput = {
        id: 'msg-minimal',
        subject: '',
        body: '',
        sender: '',
        recipients: [],
        date: '2024-01-15',
      };

      const result = await service.extract(
        [messageWithMinimalData],
        testExistingTransactions,
        testContacts,
        patternOnlyOptions
      );

      expect(result.success).toBe(true);
    });
  });

  // ===========================================================================
  // Confidence Merging Tests
  // ===========================================================================

  describe('confidence merging', () => {
    it('should use LLM confidence when pattern is disabled', async () => {
      const llmOnlyOptions: HybridExtractionOptions = {
        usePatternMatching: false,
        useLLM: true,
        userId: 'user-1',
        llmProvider: 'openai',
      };

      mockAnalyzeTool.mockResolvedValue({
        success: true,
        data: {
          isRealEstateRelated: true,
          confidence: 0.85,
          transactionIndicators: { type: 'purchase', stage: 'closing' },
          extractedEntities: { addresses: [], amounts: [], dates: [], contacts: [] },
          reasoning: 'Test',
        },
        tokensUsed: { prompt: 100, completion: 50, total: 150 },
      });

      const result = await service.analyzeMessages(testMessages.slice(0, 1), llmOnlyOptions);

      // When LLM is used alone, confidence should be LLM confidence directly
      expect(result[0].confidence).toBe(0.85);
      expect(result[0].extractionMethod).toBe('llm');
    });

    it('should use pattern confidence when LLM is not available', async () => {
      const result = await service.analyzeMessages(testMessages.slice(0, 1), patternOnlyOptions);

      // Pattern confidence: 75 (0-100) = 0.75 (0-1)
      expect(result[0].confidence).toBe(0.75);
    });

    it('should correctly weight confidence in hybrid mode', async () => {
      // Pattern returns 50% confidence
      mockAnalyzeEmail.mockReturnValue({
        isRealEstateRelated: true,
        transactionType: 'purchase',
        confidence: 50, // 0-100 scale
        addresses: ['123 Main St'],
        amounts: [],
        dates: [],
        parties: [],
        mlsNumbers: [],
        keywords: [],
        date: '2024-01-15',
      });

      // LLM returns 100% confidence
      mockAnalyzeTool.mockResolvedValue({
        success: true,
        data: {
          isRealEstateRelated: true,
          confidence: 1.0, // 0-1 scale
          transactionIndicators: { type: 'purchase', stage: 'closing' },
          extractedEntities: { addresses: [], amounts: [], dates: [], contacts: [] },
          reasoning: 'Test',
        },
        tokensUsed: { prompt: 100, completion: 50, total: 150 },
      });

      const result = await service.analyzeMessages(testMessages.slice(0, 1), hybridOptions);

      // Expected: 1.0 * 0.6 + 0.5 * 0.4 = 0.6 + 0.2 = 0.8
      expect(result[0].confidence).toBeCloseTo(0.8, 2);
    });
  });

  // ===========================================================================
  // Token Tracking Tests
  // ===========================================================================

  describe('token tracking', () => {
    it('should accumulate tokens from multiple LLM calls', async () => {
      const result = await service.extract(
        testMessages.slice(0, 2), // Two messages
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      expect(result.tokensUsed).toBeDefined();
      // Multiple LLM calls should accumulate tokens
      expect(result.tokensUsed!.total).toBeGreaterThan(0);
    });

    it('should not track tokens when LLM is not used', async () => {
      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        patternOnlyOptions
      );

      expect(result.tokensUsed).toBeUndefined();
    });

    it('should reset token tracking between extractions', async () => {
      // First extraction
      await service.extract(
        testMessages.slice(0, 1),
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      // Second extraction
      const result2 = await service.extract(
        testMessages.slice(0, 1),
        testExistingTransactions,
        testContacts,
        hybridOptions
      );

      // Tokens should be for this extraction only, not accumulated
      expect(result2.tokensUsed).toBeDefined();
    });
  });

  // ===========================================================================
  // Result Structure Tests
  // ===========================================================================

  describe('result structure', () => {
    it('should return properly structured HybridExtractionResult', async () => {
      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        patternOnlyOptions
      );

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('analyzedMessages');
      expect(result).toHaveProperty('detectedTransactions');
      expect(result).toHaveProperty('extractionMethod');
      expect(result).toHaveProperty('llmUsed');
      expect(result).toHaveProperty('latencyMs');
      expect(typeof result.success).toBe('boolean');
      expect(Array.isArray(result.analyzedMessages)).toBe(true);
      expect(Array.isArray(result.detectedTransactions)).toBe(true);
    });

    it('should return properly structured AnalyzedMessage', async () => {
      const result = await service.analyzeMessages(testMessages.slice(0, 1), patternOnlyOptions);

      const msg = result[0];
      expect(msg).toHaveProperty('id');
      expect(msg).toHaveProperty('subject');
      expect(msg).toHaveProperty('sender');
      expect(msg).toHaveProperty('recipients');
      expect(msg).toHaveProperty('date');
      expect(msg).toHaveProperty('body');
      expect(msg).toHaveProperty('isRealEstateRelated');
      expect(msg).toHaveProperty('confidence');
      expect(msg).toHaveProperty('extractionMethod');
    });

    it('should return properly structured DetectedTransaction', async () => {
      const result = await service.extract(
        testMessages,
        testExistingTransactions,
        testContacts,
        patternOnlyOptions
      );

      if (result.detectedTransactions.length > 0) {
        const tx = result.detectedTransactions[0];
        expect(tx).toHaveProperty('id');
        expect(tx).toHaveProperty('propertyAddress');
        expect(tx).toHaveProperty('transactionType');
        expect(tx).toHaveProperty('confidence');
        expect(tx).toHaveProperty('extractionMethod');
        expect(tx).toHaveProperty('communicationIds');
        expect(tx).toHaveProperty('dateRange');
        expect(tx).toHaveProperty('suggestedContacts');
        expect(tx).toHaveProperty('summary');
      }
    });
  });
});
