import OpenAI from 'openai';
import { BaseLLMService, RetryConfig } from './baseLLMService';
import {
  LLMConfig,
  LLMResponse,
  LLMMessage,
  LLMError,
  LLMErrorType,
} from './types';
import { mainNetFetch } from '../mainNetFetch';

/**
 * OpenAI LLM provider implementation.
 * Supports GPT-4o, GPT-4o-mini, and GPT-4-turbo models.
 */
export class OpenAIService extends BaseLLMService {
  private client: OpenAI | null = null;

  constructor(requestsPerMinute: number = 60, retryConfig?: RetryConfig) {
    super('openai', requestsPerMinute, retryConfig);
  }

  /**
   * Initialize the OpenAI client with an API key.
   */
  initialize(apiKey: string): void {
    this.client = new OpenAI({
      apiKey,
      timeout: this.defaultTimeout,
      // BACKLOG-3799: Chromium network stack (OS trust store / system proxy)
      fetch: mainNetFetch as unknown as typeof fetch,
    });
  }

  /**
   * Complete a chat conversation using OpenAI.
   */
  async complete(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
    if (!this.client) {
      throw this.createError(
        'OpenAI client not initialized. Call initialize() first.',
        'invalid_api_key',
        401,
        false
      );
    }

    const startTime = Date.now();

    try {
      const response = await this.client.chat.completions.create({
        model: config.model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: config.maxTokens ?? 1000,
        temperature: config.temperature ?? 0.7,
      });

      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];

      return {
        content: choice.message.content ?? '',
        tokensUsed: {
          prompt: response.usage?.prompt_tokens ?? 0,
          completion: response.usage?.completion_tokens ?? 0,
          total: response.usage?.total_tokens ?? 0,
        },
        model: response.model,
        finishReason: this.mapFinishReason(choice.finish_reason),
        latencyMs,
      };
    } catch (error) {
      throw this.handleOpenAIError(error);
    }
  }

  /**
   * Validate an API key by making a minimal API call.
   */
  async validateApiKey(apiKey: string): Promise<boolean> {
    const testClient = new OpenAI({
      apiKey,
      timeout: 10000, // 10 second timeout for validation
    });

    try {
      // Use models.list as a lightweight validation endpoint
      await testClient.models.list();
      return true;
    } catch (error) {
      // Check for authentication error by status code
      if (this.isOpenAIAPIError(error) && error.status === 401) {
        return false;
      }
      // Also check by error name for compatibility
      if (error instanceof Error && error.name === 'AuthenticationError') {
        return false;
      }
      // Network errors etc. - key might be valid, can't verify
      this.log('warn', 'API key validation failed with non-auth error', error);
      throw this.createError(
        'Could not validate API key due to network error',
        'network',
        undefined,
        true
      );
    }
  }

  /**
   * Map OpenAI errors to our error types.
   */
  private handleOpenAIError(error: unknown): LLMError {
    // Check if it's an OpenAI API error by checking for status property
    if (this.isOpenAIAPIError(error)) {
      const type = this.mapOpenAIErrorType(error);
      const retryable = this.isRetryableError(type);

      // Extract retry-after header if present
      let retryAfterMs: number | undefined;
      const headers = error.headers as Record<string, string> | undefined;
      if (headers?.['retry-after']) {
        retryAfterMs = parseInt(headers['retry-after'], 10) * 1000;
      }

      return this.createError(error.message, type, error.status, retryable, retryAfterMs);
    }

    if (error instanceof Error) {
      // Network/timeout errors
      if (error.message.includes('timeout')) {
        return this.createError(error.message, 'timeout', undefined, true);
      }
      if (error.message.includes('ECONNREFUSED') || error.message.includes('network')) {
        return this.createError(error.message, 'network', undefined, true);
      }
    }

    return this.createError(`Unknown error: ${error}`, 'unknown', undefined, false);
  }

  /**
   * Check if an error is an OpenAI API error.
   */
  private isOpenAIAPIError(
    error: unknown
  ): error is { status: number; message: string; headers?: Record<string, string> } {
    return (
      error !== null &&
      typeof error === 'object' &&
      'status' in error &&
      'message' in error &&
      typeof (error as { status: unknown }).status === 'number'
    );
  }

  private mapOpenAIErrorType(error: {
    status: number;
    message: string;
  }): LLMErrorType {
    // Map by status code primarily
    switch (error.status) {
      case 401:
        return 'invalid_api_key';
      case 429:
        return 'rate_limit';
      case 402:
      case 403:
        return 'quota_exceeded';
      case 400:
        if (
          error.message.includes('context_length') ||
          error.message.includes('maximum context')
        ) {
          return 'context_length';
        }
        return 'unknown';
      default:
        return this.mapStatusToErrorType(error.status);
    }
  }

  private mapFinishReason(reason: string | null): LLMResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }
}
