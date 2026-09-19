import {
  LLMConfig,
  LLMResponse,
  LLMMessage,
  LLMError,
  LLMErrorType,
  LLMProvider,
} from './types';
import { RateLimiter } from './rateLimiter';
import {
  createTokenEstimate,
  createTokenUsage,
  TokenEstimate,
  TokenUsage,
} from './tokenCounter';
import type { LLMSettings } from '../../types/models';
import logService from '../logService';

/**
 * Interface for database operations needed by the service.
 * Allows dependency injection for flexibility and testing.
 */
export interface LLMDbCallbacks {
  getSettings: (userId: string) => Promise<LLMSettings | null>;
  incrementTokenUsage: (userId: string, tokens: number) => Promise<void>;
  resetMonthlyUsage: (userId: string) => Promise<void>;
}

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Abstract base class for LLM provider implementations.
 * Provides common functionality and defines the contract for specific providers.
 */
export abstract class BaseLLMService {
  protected readonly provider: LLMProvider;
  protected readonly defaultTimeout = 30000; // 30 seconds
  protected readonly rateLimiter: RateLimiter;
  protected readonly retryConfig: RetryConfig;
  protected dbCallbacks?: LLMDbCallbacks;

  constructor(
    provider: LLMProvider,
    requestsPerMinute: number = 60,
    retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
  ) {
    this.provider = provider;
    this.rateLimiter = new RateLimiter(requestsPerMinute);
    this.retryConfig = retryConfig;
  }

  /**
   * Complete a chat conversation with the LLM.
   * Must be implemented by provider-specific classes.
   */
  abstract complete(
    messages: LLMMessage[],
    config: LLMConfig
  ): Promise<LLMResponse>;

  /**
   * Validate an API key by making a minimal API call.
   * Must be implemented by provider-specific classes.
   */
  abstract validateApiKey(apiKey: string): Promise<boolean>;

  /**
   * Get the provider name for this service.
   */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /**
   * Execute a completion with retry and rate limiting.
   * This is the recommended way to call completions.
   */
  async completeWithRetry(
    messages: LLMMessage[],
    config: LLMConfig
  ): Promise<LLMResponse> {
    // Wait for rate limiter
    const waitTime = await this.rateLimiter.acquire();
    if (waitTime > 0) {
      this.log('info', `Rate limited, waited ${waitTime}ms`);
    }

    let lastError: LLMError | undefined;
    let delay = this.retryConfig.initialDelayMs;

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt++) {
      try {
        return await this.complete(messages, config);
      } catch (error) {
        if (error instanceof LLMError) {
          lastError = error;

          // Don't retry non-retryable errors
          if (!error.retryable) {
            throw error;
          }

          // Use Retry-After header if provided
          const retryDelay = error.retryAfterMs ?? delay;

          this.log('warn', `Attempt ${attempt} failed, retrying in ${retryDelay}ms`, {
            type: error.type,
            message: error.message,
          });

          if (attempt < this.retryConfig.maxAttempts) {
            await this.sleep(retryDelay);
            delay = Math.min(
              delay * this.retryConfig.backoffMultiplier,
              this.retryConfig.maxDelayMs
            );
          }
        } else {
          // Unknown error, wrap and throw
          throw this.createError(
            `Unexpected error: ${error}`,
            'unknown',
            undefined,
            false
          );
        }
      }
    }

    // All retries exhausted
    throw lastError ?? this.createError(
      'All retry attempts failed',
      'unknown',
      undefined,
      false
    );
  }

  /**
   * Check if the service is currently rate limited.
   */
  isRateLimited(): boolean {
    return this.rateLimiter.getWaitTime() > 0;
  }

  /**
   * Get estimated wait time until next request allowed (ms).
   */
  getWaitTime(): number {
    return this.rateLimiter.getWaitTime();
  }

  /**
   * Set the database callbacks for usage tracking.
   * Must be called before tracking is enabled.
   */
  setDbCallbacks(callbacks: LLMDbCallbacks): void {
    this.dbCallbacks = callbacks;
  }

  /**
   * Estimate tokens before making an API call.
   */
  estimateTokens(
    messages: LLMMessage[],
    maxCompletionTokens: number,
    model: string
  ): TokenEstimate {
    return createTokenEstimate(messages, maxCompletionTokens, this.provider, model);
  }

  /**
   * Check if user has budget for estimated tokens.
   */
  async checkBudget(
    userId: string,
    estimate: TokenEstimate
  ): Promise<{ allowed: boolean; remaining: number; reason?: string }> {
    if (!this.dbCallbacks) {
      return { allowed: true, remaining: Infinity }; // No tracking enabled
    }

    const settings = await this.dbCallbacks.getSettings(userId);
    if (!settings) {
      return { allowed: true, remaining: Infinity }; // No settings = no limit
    }

    // Check monthly reset
    if (this.shouldResetMonthly(settings.budget_reset_date)) {
      await this.dbCallbacks.resetMonthlyUsage(userId);
    }

    const limit = settings.use_platform_allowance
      ? settings.platform_allowance_tokens
      : settings.budget_limit_tokens;

    if (!limit) {
      return { allowed: true, remaining: Infinity }; // No limit set
    }

    const used = settings.use_platform_allowance
      ? settings.platform_allowance_used
      : settings.tokens_used_this_month;

    const remaining = limit - used;

    if (estimate.totalEstimate > remaining) {
      return {
        allowed: false,
        remaining,
        reason: `Estimated ${estimate.totalEstimate} tokens exceeds remaining budget of ${remaining}`,
      };
    }

    return { allowed: true, remaining };
  }

  /**
   * Record actual token usage after API call.
   */
  async recordUsage(userId: string, usage: TokenUsage): Promise<void> {
    if (!this.dbCallbacks) return;

    await this.dbCallbacks.incrementTokenUsage(userId, usage.totalTokens);
    this.log('info', `Recorded ${usage.totalTokens} tokens for user ${userId}`);
  }

  /**
   * Complete with budget check and usage tracking.
   */
  async completeWithTracking(
    userId: string,
    messages: LLMMessage[],
    config: LLMConfig
  ): Promise<LLMResponse> {
    const maxTokens = config.maxTokens ?? 1000;
    const estimate = this.estimateTokens(messages, maxTokens, config.model);

    // Check budget
    const budgetCheck = await this.checkBudget(userId, estimate);
    if (!budgetCheck.allowed) {
      throw this.createError(
        budgetCheck.reason ?? 'Budget exceeded',
        'quota_exceeded',
        402,
        false
      );
    }

    // Make the API call
    const response = await this.completeWithRetry(messages, config);

    // Record actual usage
    const usage = createTokenUsage(
      response.tokensUsed.prompt,
      response.tokensUsed.completion,
      this.provider,
      config.model
    );
    await this.recordUsage(userId, usage);

    return response;
  }

  /**
   * Check if monthly usage should be reset.
   */
  private shouldResetMonthly(resetDate?: string): boolean {
    if (!resetDate) return true;
    const reset = new Date(resetDate);
    const now = new Date();
    return (
      reset.getMonth() !== now.getMonth() || reset.getFullYear() !== now.getFullYear()
    );
  }

  /**
   * Create a standardized error from provider-specific errors.
   * Subclasses should call this to create consistent error objects.
   */
  protected createError(
    message: string,
    type: LLMErrorType,
    statusCode?: number,
    retryable: boolean = false,
    retryAfterMs?: number
  ): LLMError {
    return new LLMError(
      message,
      type,
      this.provider,
      statusCode,
      retryable,
      retryAfterMs
    );
  }

  /**
   * Map HTTP status codes to error types.
   */
  protected mapStatusToErrorType(status: number): LLMErrorType {
    switch (status) {
      case 401:
        return 'invalid_api_key';
      case 429:
        return 'rate_limit';
      case 402:
      case 403:
        return 'quota_exceeded';
      case 400:
        return 'context_length'; // Often indicates token limit
      default:
        return 'unknown';
    }
  }

  /**
   * Check if an error is retryable.
   */
  protected isRetryableError(type: LLMErrorType): boolean {
    return ['rate_limit', 'network', 'timeout'].includes(type);
  }

  /**
   * Log LLM operation (for debugging/monitoring).
   * Override in subclasses for custom logging.
   */
  protected log(
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: unknown
  ): void {
    const context = `LLM:${this.provider}`;
    switch (level) {
      case 'info':
        logService.info(message, context, data ? { data } : undefined);
        break;
      case 'warn':
        logService.warn(message, context, data ? { data } : undefined);
        break;
      case 'error':
        logService.error(message, context, data ? { data } : undefined);
        break;
    }
  }

  /**
   * Build a simple completion prompt from a single user message.
   * Convenience method for simple use cases.
   */
  protected buildSimplePrompt(
    systemPrompt: string,
    userMessage: string
  ): LLMMessage[] {
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];
  }

  /**
   * Sleep for a specified number of milliseconds.
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
