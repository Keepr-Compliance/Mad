/**
 * @jest-environment node
 */

import type { LLMSettings } from '../../../types/models';

// Mock dependencies
const mockGetLLMSettingsByUserId = jest.fn();
const mockGetOrCreateLLMSettings = jest.fn();
const mockUpdateLLMSettings = jest.fn();
const mockClearLLMSettingsField = jest.fn();
const mockSetLLMDataConsent = jest.fn();
const mockIncrementTokenUsage = jest.fn();
const mockIncrementPlatformAllowanceUsage = jest.fn();

jest.mock('../../db/llmSettingsDbService', () => ({
  getLLMSettingsByUserId: mockGetLLMSettingsByUserId,
  getOrCreateLLMSettings: mockGetOrCreateLLMSettings,
  updateLLMSettings: mockUpdateLLMSettings,
  clearLLMSettingsField: mockClearLLMSettingsField,
  setLLMDataConsent: mockSetLLMDataConsent,
  incrementTokenUsage: mockIncrementTokenUsage,
  incrementPlatformAllowanceUsage: mockIncrementPlatformAllowanceUsage,
}));

const mockEncrypt = jest.fn();
const mockDecrypt = jest.fn();

jest.mock('../../tokenEncryptionService', () => ({
  __esModule: true,
  default: {
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
  },
}));

const mockOpenAIValidateApiKey = jest.fn();
const mockOpenAIInitialize = jest.fn();
const mockOpenAISetDbCallbacks = jest.fn();
const mockOpenAICompleteWithTracking = jest.fn();

jest.mock('../openAIService', () => ({
  OpenAIService: jest.fn().mockImplementation(() => ({
    validateApiKey: mockOpenAIValidateApiKey,
    initialize: mockOpenAIInitialize,
    setDbCallbacks: mockOpenAISetDbCallbacks,
    completeWithTracking: mockOpenAICompleteWithTracking,
  })),
}));

const mockAnthropicValidateApiKey = jest.fn();
const mockAnthropicInitialize = jest.fn();
const mockAnthropicSetDbCallbacks = jest.fn();
const mockAnthropicCompleteWithTracking = jest.fn();

jest.mock('../anthropicService', () => ({
  AnthropicService: jest.fn().mockImplementation(() => ({
    validateApiKey: mockAnthropicValidateApiKey,
    initialize: mockAnthropicInitialize,
    setDbCallbacks: mockAnthropicSetDbCallbacks,
    completeWithTracking: mockAnthropicCompleteWithTracking,
  })),
}));

// Import after mocking
import { LLMConfigService } from '../llmConfigService';

describe('LLMConfigService', () => {
  let service: LLMConfigService;
  const testUserId = 'user-123';

  // Default test settings
  const createDefaultSettings = (overrides?: Partial<LLMSettings>): LLMSettings => ({
    id: 'settings-1',
    user_id: testUserId,
    preferred_provider: 'openai',
    openai_model: 'gpt-4o-mini',
    anthropic_model: 'claude-3-haiku-20240307',
    tokens_used_this_month: 0,
    platform_allowance_tokens: 10000,
    platform_allowance_used: 0,
    use_platform_allowance: false,
    enable_auto_detect: true,
    enable_role_extraction: true,
    llm_data_consent: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LLMConfigService();
  });

  describe('constructor', () => {
    it('should initialize services and set up db callbacks', () => {
      expect(mockOpenAISetDbCallbacks).toHaveBeenCalled();
      expect(mockAnthropicSetDbCallbacks).toHaveBeenCalled();
    });
  });

  describe('getUserConfig', () => {
    it('should return user config from settings', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-key',
        tokens_used_this_month: 5000,
        budget_limit_tokens: 50000,
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const config = await service.getUserConfig(testUserId);

      expect(config).toEqual({
        hasOpenAI: true,
        hasAnthropic: false,
        preferredProvider: 'openai',
        openAIModel: 'gpt-4o-mini',
        anthropicModel: 'claude-3-haiku-20240307',
        tokensUsed: 5000,
        budgetLimit: 50000,
        platformAllowanceRemaining: 10000,
        usePlatformAllowance: false,
        autoDetectEnabled: true,
        roleExtractionEnabled: true,
        hasConsent: true,
      });
    });

    it('should create default settings if none exist', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      await service.getUserConfig(testUserId);

      expect(mockGetOrCreateLLMSettings).toHaveBeenCalledWith(testUserId);
    });

    it('should indicate no API keys when none configured', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const config = await service.getUserConfig(testUserId);

      expect(config.hasOpenAI).toBe(false);
      expect(config.hasAnthropic).toBe(false);
    });

    it('should calculate platform allowance remaining correctly', async () => {
      const settings = createDefaultSettings({
        platform_allowance_tokens: 10000,
        platform_allowance_used: 3000,
        use_platform_allowance: true,
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const config = await service.getUserConfig(testUserId);

      expect(config.platformAllowanceRemaining).toBe(7000);
    });
  });

  describe('setApiKey', () => {
    it('should encrypt and store OpenAI API key', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);
      mockEncrypt.mockReturnValue('encrypted-openai-key');

      await service.setApiKey(testUserId, 'openai', 'sk-test-key');

      expect(mockEncrypt).toHaveBeenCalledWith('sk-test-key');
      expect(mockUpdateLLMSettings).toHaveBeenCalledWith(testUserId, {
        openai_api_key_encrypted: 'encrypted-openai-key',
      });
    });

    it('should encrypt and store Anthropic API key', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);
      mockEncrypt.mockReturnValue('encrypted-anthropic-key');

      await service.setApiKey(testUserId, 'anthropic', 'sk-ant-test-key');

      expect(mockEncrypt).toHaveBeenCalledWith('sk-ant-test-key');
      expect(mockUpdateLLMSettings).toHaveBeenCalledWith(testUserId, {
        anthropic_api_key_encrypted: 'encrypted-anthropic-key',
      });
    });

    it('should ensure settings exist before updating', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);
      mockEncrypt.mockReturnValue('encrypted-key');

      await service.setApiKey(testUserId, 'openai', 'test-key');

      expect(mockGetOrCreateLLMSettings).toHaveBeenCalledWith(testUserId);
    });
  });

  describe('validateApiKey', () => {
    it('should validate OpenAI API key', async () => {
      mockOpenAIValidateApiKey.mockResolvedValue(true);

      const result = await service.validateApiKey('openai', 'sk-test-key');

      expect(result).toBe(true);
      expect(mockOpenAIValidateApiKey).toHaveBeenCalledWith('sk-test-key');
    });

    it('should validate Anthropic API key', async () => {
      mockAnthropicValidateApiKey.mockResolvedValue(true);

      const result = await service.validateApiKey('anthropic', 'sk-ant-test-key');

      expect(result).toBe(true);
      expect(mockAnthropicValidateApiKey).toHaveBeenCalledWith('sk-ant-test-key');
    });

    it('should return false for invalid key', async () => {
      mockOpenAIValidateApiKey.mockResolvedValue(false);

      const result = await service.validateApiKey('openai', 'invalid-key');

      expect(result).toBe(false);
    });
  });

  describe('removeApiKey', () => {
    /**
     * BACKLOG-2932. These two tests used to assert
     * `updateLLMSettings(userId, { openai_api_key_encrypted: undefined })` —
     * they asserted the BUG. `updateLLMSettings` skips undefined values, so
     * that payload emptied out and no UPDATE ever ran while Settings reported
     * success.
     *
     * They are kept here because a caller-level contract is worth pinning, but
     * they are NOT the control: this whole suite mocks the db module, and with
     * the undefined payload reinstated it still passes 40/40. The control that
     * goes red is the end-to-end one in
     * `db/__tests__/writerColumnParity-2560.test.ts`, which drives this same
     * method into a real database and reads the row back.
     */
    it('should remove OpenAI API key', async () => {
      await service.removeApiKey(testUserId, 'openai');

      expect(mockClearLLMSettingsField).toHaveBeenCalledWith(
        testUserId,
        'openai_api_key_encrypted'
      );
      // Never through the update path — that is where the key survived.
      expect(mockUpdateLLMSettings).not.toHaveBeenCalled();
    });

    it('should remove Anthropic API key', async () => {
      await service.removeApiKey(testUserId, 'anthropic');

      expect(mockClearLLMSettingsField).toHaveBeenCalledWith(
        testUserId,
        'anthropic_api_key_encrypted'
      );
      expect(mockUpdateLLMSettings).not.toHaveBeenCalled();
    });
  });

  describe('updatePreferences', () => {
    it('should update preferred provider', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      await service.updatePreferences(testUserId, {
        preferredProvider: 'anthropic',
      });

      expect(mockUpdateLLMSettings).toHaveBeenCalledWith(testUserId, {
        preferred_provider: 'anthropic',
      });
    });

    it('should update multiple preferences at once', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      await service.updatePreferences(testUserId, {
        preferredProvider: 'anthropic',
        openAIModel: 'gpt-4o',
        anthropicModel: 'claude-3-5-sonnet-20241022',
        enableAutoDetect: false,
        enableRoleExtraction: false,
        usePlatformAllowance: true,
        budgetLimit: 100000,
      });

      expect(mockUpdateLLMSettings).toHaveBeenCalledWith(testUserId, {
        preferred_provider: 'anthropic',
        openai_model: 'gpt-4o',
        anthropic_model: 'claude-3-5-sonnet-20241022',
        enable_auto_detect: false,
        enable_role_extraction: false,
        use_platform_allowance: true,
        budget_limit_tokens: 100000,
      });
    });

    it('should not include undefined preferences in update', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      await service.updatePreferences(testUserId, {
        preferredProvider: 'openai',
      });

      const updateCall = mockUpdateLLMSettings.mock.calls[0][1];
      expect(Object.keys(updateCall)).toEqual(['preferred_provider']);
    });
  });

  describe('recordConsent', () => {
    it('should record consent as true', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      await service.recordConsent(testUserId, true);

      expect(mockSetLLMDataConsent).toHaveBeenCalledWith(testUserId, true);
    });

    it('should record consent as false', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      await service.recordConsent(testUserId, false);

      expect(mockSetLLMDataConsent).toHaveBeenCalledWith(testUserId, false);
    });

    it('should ensure settings exist before recording consent', async () => {
      const settings = createDefaultSettings();
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      await service.recordConsent(testUserId, true);

      expect(mockGetOrCreateLLMSettings).toHaveBeenCalledWith(testUserId);
    });
  });

  describe('complete', () => {
    const testMessages = [{ role: 'user' as const, content: 'Hello' }];
    const testResponse = {
      content: 'Hi there!',
      tokensUsed: { prompt: 10, completion: 5, total: 15 },
      model: 'gpt-4o-mini',
      finishReason: 'stop' as const,
      latencyMs: 100,
    };

    it('should throw error if settings not found', async () => {
      mockGetLLMSettingsByUserId.mockReturnValue(null);

      await expect(service.complete(testUserId, testMessages)).rejects.toMatchObject({
        type: 'invalid_api_key',
        message: expect.stringContaining('not configured'),
      });
    });

    it('should throw error if consent not given', async () => {
      const settings = createDefaultSettings({
        llm_data_consent: false,
        openai_api_key_encrypted: 'encrypted-key',
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);

      await expect(service.complete(testUserId, testMessages)).rejects.toMatchObject({
        type: 'quota_exceeded',
        message: expect.stringContaining('consent required'),
      });
    });

    it('should complete with OpenAI when preferred', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-key',
        preferred_provider: 'openai',
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);
      mockDecrypt.mockReturnValue('decrypted-api-key');
      mockOpenAICompleteWithTracking.mockResolvedValue(testResponse);

      const result = await service.complete(testUserId, testMessages);

      expect(mockDecrypt).toHaveBeenCalledWith('encrypted-key');
      expect(mockOpenAIInitialize).toHaveBeenCalledWith('decrypted-api-key');
      expect(mockOpenAICompleteWithTracking).toHaveBeenCalledWith(
        testUserId,
        testMessages,
        expect.objectContaining({
          provider: 'openai',
          model: 'gpt-4o-mini',
        })
      );
      expect(result).toEqual(testResponse);
    });

    it('should complete with Anthropic when preferred', async () => {
      const settings = createDefaultSettings({
        anthropic_api_key_encrypted: 'encrypted-ant-key',
        preferred_provider: 'anthropic',
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);
      mockDecrypt.mockReturnValue('decrypted-ant-key');
      mockAnthropicCompleteWithTracking.mockResolvedValue(testResponse);

      const result = await service.complete(testUserId, testMessages);

      expect(mockDecrypt).toHaveBeenCalledWith('encrypted-ant-key');
      expect(mockAnthropicInitialize).toHaveBeenCalledWith('decrypted-ant-key');
      expect(mockAnthropicCompleteWithTracking).toHaveBeenCalled();
      expect(result).toEqual(testResponse);
    });

    it('should override provider when specified in options', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-openai-key',
        anthropic_api_key_encrypted: 'encrypted-ant-key',
        preferred_provider: 'openai',
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);
      mockDecrypt.mockReturnValue('decrypted-key');
      mockAnthropicCompleteWithTracking.mockResolvedValue(testResponse);

      await service.complete(testUserId, testMessages, { provider: 'anthropic' });

      expect(mockAnthropicCompleteWithTracking).toHaveBeenCalled();
      expect(mockOpenAICompleteWithTracking).not.toHaveBeenCalled();
    });

    it('should pass maxTokens and temperature options', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-key',
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);
      mockDecrypt.mockReturnValue('decrypted-key');
      mockOpenAICompleteWithTracking.mockResolvedValue(testResponse);

      await service.complete(testUserId, testMessages, {
        maxTokens: 500,
        temperature: 0.5,
      });

      expect(mockOpenAICompleteWithTracking).toHaveBeenCalledWith(
        testUserId,
        testMessages,
        expect.objectContaining({
          maxTokens: 500,
          temperature: 0.5,
        })
      );
    });

    it('should throw error if OpenAI key not configured', async () => {
      const settings = createDefaultSettings({
        preferred_provider: 'openai',
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);

      await expect(service.complete(testUserId, testMessages)).rejects.toMatchObject({
        type: 'invalid_api_key',
        message: expect.stringContaining('OpenAI API key not configured'),
      });
    });

    it('should throw error if Anthropic key not configured', async () => {
      const settings = createDefaultSettings({
        preferred_provider: 'anthropic',
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);

      await expect(service.complete(testUserId, testMessages)).rejects.toMatchObject({
        type: 'invalid_api_key',
        message: expect.stringContaining('Anthropic API key not configured'),
      });
    });

    it('should track platform allowance usage when enabled', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-key',
        use_platform_allowance: true,
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);
      mockDecrypt.mockReturnValue('decrypted-key');
      mockOpenAICompleteWithTracking.mockResolvedValue(testResponse);

      await service.complete(testUserId, testMessages);

      expect(mockIncrementPlatformAllowanceUsage).toHaveBeenCalledWith(
        testUserId,
        testResponse.tokensUsed.total
      );
    });

    it('should not track platform allowance when disabled', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-key',
        use_platform_allowance: false,
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);
      mockDecrypt.mockReturnValue('decrypted-key');
      mockOpenAICompleteWithTracking.mockResolvedValue(testResponse);

      await service.complete(testUserId, testMessages);

      expect(mockIncrementPlatformAllowanceUsage).not.toHaveBeenCalled();
    });
  });

  describe('getUsageStats', () => {
    it('should return usage stats from settings', async () => {
      const settings = createDefaultSettings({
        tokens_used_this_month: 5000,
        budget_limit_tokens: 50000,
        platform_allowance_tokens: 10000,
        platform_allowance_used: 2000,
        budget_reset_date: '2024-02-01',
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);

      const stats = await service.getUsageStats(testUserId);

      expect(stats).toEqual({
        tokensThisMonth: 5000,
        budgetLimit: 50000,
        budgetRemaining: 45000,
        platformAllowance: 10000,
        platformUsed: 2000,
        resetDate: '2024-02-01',
      });
    });

    it('should return zeros if no settings found', async () => {
      mockGetLLMSettingsByUserId.mockReturnValue(null);

      const stats = await service.getUsageStats(testUserId);

      expect(stats).toEqual({
        tokensThisMonth: 0,
        platformAllowance: 0,
        platformUsed: 0,
      });
    });

    it('should handle no budget limit', async () => {
      const settings = createDefaultSettings({
        tokens_used_this_month: 5000,
        budget_limit_tokens: undefined,
      });
      mockGetLLMSettingsByUserId.mockReturnValue(settings);

      const stats = await service.getUsageStats(testUserId);

      expect(stats.budgetLimit).toBeUndefined();
      expect(stats.budgetRemaining).toBeUndefined();
    });
  });

  describe('canUseLLM', () => {
    it('should return false if no consent', async () => {
      const settings = createDefaultSettings({
        llm_data_consent: false,
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const result = await service.canUseLLM(testUserId);

      expect(result).toEqual({
        canUse: false,
        reason: 'LLM data consent required',
      });
    });

    it('should return false if no API key and no platform allowance', async () => {
      const settings = createDefaultSettings({
        use_platform_allowance: false,
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const result = await service.canUseLLM(testUserId);

      expect(result).toEqual({
        canUse: false,
        reason: 'No API key configured',
      });
    });

    it('should return false if budget exceeded', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-key',
        tokens_used_this_month: 50000,
        budget_limit_tokens: 50000,
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const result = await service.canUseLLM(testUserId);

      expect(result).toEqual({
        canUse: false,
        reason: 'Monthly budget exceeded',
      });
    });

    it('should return false if platform allowance exhausted', async () => {
      const settings = createDefaultSettings({
        use_platform_allowance: true,
        platform_allowance_tokens: 10000,
        platform_allowance_used: 10000,
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const result = await service.canUseLLM(testUserId);

      expect(result).toEqual({
        canUse: false,
        reason: 'Platform allowance exhausted',
      });
    });

    it('should return true with OpenAI key configured', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-key',
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const result = await service.canUseLLM(testUserId);

      expect(result).toEqual({ canUse: true });
    });

    it('should return true with Anthropic key configured', async () => {
      const settings = createDefaultSettings({
        anthropic_api_key_encrypted: 'encrypted-key',
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const result = await service.canUseLLM(testUserId);

      expect(result).toEqual({ canUse: true });
    });

    it('should return true with platform allowance enabled and remaining', async () => {
      const settings = createDefaultSettings({
        use_platform_allowance: true,
        platform_allowance_tokens: 10000,
        platform_allowance_used: 5000,
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const result = await service.canUseLLM(testUserId);

      expect(result).toEqual({ canUse: true });
    });

    it('should return true if under budget limit', async () => {
      const settings = createDefaultSettings({
        openai_api_key_encrypted: 'encrypted-key',
        tokens_used_this_month: 40000,
        budget_limit_tokens: 50000,
      });
      mockGetOrCreateLLMSettings.mockReturnValue(settings);

      const result = await service.canUseLLM(testUserId);

      expect(result).toEqual({ canUse: true });
    });
  });
});
