/**
 * LLM Configuration Service
 * Orchestrates LLM provider management, API key storage, and configuration.
 *
 * SECURITY:
 * - API keys encrypted before storage using tokenEncryptionService
 * - Consent check BEFORE any LLM operation (Security Option C)
 * - Never expose raw LLMSettings to UI - use LLMUserConfig interface
 * - Decrypts API keys only when needed (not cached)
 */

import type { LLMSettings } from '../../types/models';
import {
  getLLMSettingsByUserId,
  getOrCreateLLMSettings,
  updateLLMSettings,
  clearLLMSettingsField,
  setLLMDataConsent,
  incrementTokenUsage,
  incrementPlatformAllowanceUsage,
} from '../db/llmSettingsDbService';
import tokenEncryptionService from '../tokenEncryptionService';
import { OpenAIService } from './openAIService';
import { AnthropicService } from './anthropicService';
import {
  LLMConfig,
  LLMResponse,
  LLMMessage,
  LLMProvider,
  LLMError,
} from './types';
import type { LLMDbCallbacks } from './baseLLMService';

/**
 * User-facing LLM configuration summary.
 * Never exposes raw API keys or sensitive settings.
 */
export interface LLMUserConfig {
  hasOpenAI: boolean;
  hasAnthropic: boolean;
  preferredProvider: LLMProvider;
  openAIModel: string;
  anthropicModel: string;
  tokensUsed: number;
  budgetLimit?: number;
  platformAllowanceRemaining: number;
  usePlatformAllowance: boolean;
  autoDetectEnabled: boolean;
  roleExtractionEnabled: boolean;
  hasConsent: boolean;
}

/**
 * Preferences that can be updated by the user.
 */
export interface LLMPreferences {
  preferredProvider?: LLMProvider;
  openAIModel?: string;
  anthropicModel?: string;
  enableAutoDetect?: boolean;
  enableRoleExtraction?: boolean;
  usePlatformAllowance?: boolean;
  budgetLimit?: number;
}

/**
 * Usage statistics for display.
 */
export interface LLMUsageStats {
  tokensThisMonth: number;
  budgetLimit?: number;
  budgetRemaining?: number;
  platformAllowance: number;
  platformUsed: number;
  resetDate?: string;
}

/**
 * Result of canUseLLM check.
 */
export interface LLMAvailability {
  canUse: boolean;
  reason?: string;
}

/**
 * LLM Configuration Service
 * Orchestrates all LLM-related operations including:
 * - Provider configuration
 * - Secure API key management
 * - User preferences
 * - Budget checking
 * - Consent management
 */
export class LLMConfigService {
  private openAIService: OpenAIService;
  private anthropicService: AnthropicService;

  constructor() {
    this.openAIService = new OpenAIService();
    this.anthropicService = new AnthropicService();

    // Set up database callbacks for usage tracking
    const dbCallbacks: LLMDbCallbacks = {
      getSettings: getLLMSettingsByUserId,
      incrementTokenUsage: incrementTokenUsage,
      resetMonthlyUsage: () => {
        // Monthly reset is handled by the database service
        // This callback is for the base service's internal use
      },
    };

    this.openAIService.setDbCallbacks(dbCallbacks);
    this.anthropicService.setDbCallbacks(dbCallbacks);
  }

  /**
   * Get user's LLM configuration summary.
   * Creates default settings if none exist.
   */
  async getUserConfig(userId: string): Promise<LLMUserConfig> {
    const settings = getOrCreateLLMSettings(userId);

    return {
      hasOpenAI: !!settings.openai_api_key_encrypted,
      hasAnthropic: !!settings.anthropic_api_key_encrypted,
      preferredProvider: settings.preferred_provider,
      openAIModel: settings.openai_model,
      anthropicModel: settings.anthropic_model,
      tokensUsed: settings.tokens_used_this_month,
      budgetLimit: settings.budget_limit_tokens ?? undefined,
      platformAllowanceRemaining:
        settings.platform_allowance_tokens - settings.platform_allowance_used,
      usePlatformAllowance: settings.use_platform_allowance,
      autoDetectEnabled: settings.enable_auto_detect,
      roleExtractionEnabled: settings.enable_role_extraction,
      hasConsent: settings.llm_data_consent,
    };
  }

  /**
   * Set API key for a provider.
   * Encrypts the key before storage.
   */
  async setApiKey(
    userId: string,
    provider: LLMProvider,
    apiKey: string
  ): Promise<void> {
    const encryptedKey = tokenEncryptionService.encrypt(apiKey);

    const updates: Partial<LLMSettings> =
      provider === 'openai'
        ? { openai_api_key_encrypted: encryptedKey }
        : { anthropic_api_key_encrypted: encryptedKey };

    // Ensure settings exist first
    getOrCreateLLMSettings(userId);
    updateLLMSettings(userId, updates);
  }

  /**
   * Validate an API key without storing it.
   * Makes a minimal API call to verify the key works.
   */
  async validateApiKey(provider: LLMProvider, apiKey: string): Promise<boolean> {
    if (provider === 'openai') {
      return this.openAIService.validateApiKey(apiKey);
    } else {
      return this.anthropicService.validateApiKey(apiKey);
    }
  }

  /**
   * Remove API key for a provider.
   */
  async removeApiKey(userId: string, provider: LLMProvider): Promise<void> {
    // BACKLOG-2932: this passed `{ <col>: undefined }` to `updateLLMSettings`,
    // which skips undefined values — the payload emptied out, no UPDATE ran, and
    // the settings row came back as a success value with the key still in it.
    // Settings > AI > Remove reported success and re-masked the key on reload.
    // Clearing is now its own verb, so the mistake is no longer expressible.
    clearLLMSettingsField(
      userId,
      provider === 'openai'
        ? 'openai_api_key_encrypted'
        : 'anthropic_api_key_encrypted'
    );
  }

  /**
   * Update provider preferences.
   */
  async updatePreferences(
    userId: string,
    preferences: LLMPreferences
  ): Promise<void> {
    const updates: Partial<LLMSettings> = {};

    if (preferences.preferredProvider !== undefined) {
      updates.preferred_provider = preferences.preferredProvider;
    }
    if (preferences.openAIModel !== undefined) {
      updates.openai_model = preferences.openAIModel;
    }
    if (preferences.anthropicModel !== undefined) {
      updates.anthropic_model = preferences.anthropicModel;
    }
    if (preferences.enableAutoDetect !== undefined) {
      updates.enable_auto_detect = preferences.enableAutoDetect;
    }
    if (preferences.enableRoleExtraction !== undefined) {
      updates.enable_role_extraction = preferences.enableRoleExtraction;
    }
    if (preferences.usePlatformAllowance !== undefined) {
      updates.use_platform_allowance = preferences.usePlatformAllowance;
    }
    if (preferences.budgetLimit !== undefined) {
      updates.budget_limit_tokens = preferences.budgetLimit;
    }

    // Ensure settings exist first
    getOrCreateLLMSettings(userId);
    updateLLMSettings(userId, updates);
  }

  /**
   * Record user consent for LLM data processing.
   */
  async recordConsent(userId: string, consent: boolean): Promise<void> {
    // Ensure settings exist first
    getOrCreateLLMSettings(userId);
    setLLMDataConsent(userId, consent);
  }

  /**
   * Complete a chat using the configured provider.
   * SECURITY: Checks consent before any LLM operation.
   */
  async complete(
    userId: string,
    messages: LLMMessage[],
    options?: {
      provider?: LLMProvider;
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<LLMResponse> {
    const settings = getLLMSettingsByUserId(userId);
    if (!settings) {
      throw new LLMError(
        'LLM not configured. Please add an API key in settings.',
        'invalid_api_key',
        'openai', // Default
        401,
        false
      );
    }

    // SECURITY: Check consent before any LLM operation
    if (!settings.llm_data_consent) {
      throw new LLMError(
        'LLM data consent required. Please enable in settings.',
        'quota_exceeded',
        settings.preferred_provider,
        403,
        false
      );
    }

    // Determine provider
    const provider = options?.provider ?? settings.preferred_provider;
    const service = this.getServiceForProvider(provider, settings);

    // Build config
    const config: LLMConfig = {
      provider,
      apiKey: '', // Set by service initialization
      model:
        provider === 'openai' ? settings.openai_model : settings.anthropic_model,
      maxTokens: options?.maxTokens ?? 1000,
      temperature: options?.temperature ?? 0.7,
    };

    // Complete with tracking
    const response = await service.completeWithTracking(userId, messages, config);

    // Track platform allowance usage if enabled
    if (settings.use_platform_allowance) {
      incrementPlatformAllowanceUsage(userId, response.tokensUsed.total);
    }

    return response;
  }

  /**
   * Get usage statistics.
   */
  async getUsageStats(userId: string): Promise<LLMUsageStats> {
    const settings = getLLMSettingsByUserId(userId);
    if (!settings) {
      return {
        tokensThisMonth: 0,
        platformAllowance: 0,
        platformUsed: 0,
      };
    }

    return {
      tokensThisMonth: settings.tokens_used_this_month,
      budgetLimit: settings.budget_limit_tokens ?? undefined,
      budgetRemaining: settings.budget_limit_tokens
        ? settings.budget_limit_tokens - settings.tokens_used_this_month
        : undefined,
      platformAllowance: settings.platform_allowance_tokens,
      platformUsed: settings.platform_allowance_used,
      resetDate: settings.budget_reset_date ?? undefined,
    };
  }

  /**
   * Check if user can make LLM requests.
   */
  async canUseLLM(userId: string): Promise<LLMAvailability> {
    const config = await this.getUserConfig(userId);

    if (!config.hasConsent) {
      return { canUse: false, reason: 'LLM data consent required' };
    }

    if (!config.hasOpenAI && !config.hasAnthropic && !config.usePlatformAllowance) {
      return { canUse: false, reason: 'No API key configured' };
    }

    if (config.budgetLimit && config.tokensUsed >= config.budgetLimit) {
      return { canUse: false, reason: 'Monthly budget exceeded' };
    }

    if (config.usePlatformAllowance && config.platformAllowanceRemaining <= 0) {
      return { canUse: false, reason: 'Platform allowance exhausted' };
    }

    return { canUse: true };
  }

  /**
   * Get the appropriate service for a provider and initialize it.
   * @private
   */
  private getServiceForProvider(
    provider: LLMProvider,
    settings: LLMSettings
  ): OpenAIService | AnthropicService {
    if (provider === 'openai') {
      if (!settings.openai_api_key_encrypted) {
        throw new LLMError(
          'OpenAI API key not configured',
          'invalid_api_key',
          'openai',
          401,
          false
        );
      }
      const apiKey = tokenEncryptionService.decrypt(
        settings.openai_api_key_encrypted
      );
      this.openAIService.initialize(apiKey);
      return this.openAIService;
    } else {
      if (!settings.anthropic_api_key_encrypted) {
        throw new LLMError(
          'Anthropic API key not configured',
          'invalid_api_key',
          'anthropic',
          401,
          false
        );
      }
      const apiKey = tokenEncryptionService.decrypt(
        settings.anthropic_api_key_encrypted
      );
      this.anthropicService.initialize(apiKey);
      return this.anthropicService;
    }
  }
}

// Export singleton instance for convenience
export const llmConfigService = new LLMConfigService();
export default llmConfigService;
