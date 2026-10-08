import Anthropic from '@anthropic-ai/sdk';
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
 * Anthropic LLM provider implementation.
 * Supports Claude 3 models (Haiku, Sonnet, Opus).
 */
export class AnthropicService extends BaseLLMService {
  private client: Anthropic | null = null;

  constructor(requestsPerMinute: number = 60, retryConfig?: RetryConfig) {
    super('anthropic', requestsPerMinute, retryConfig);
  }

  /**
   * Initialize the Anthropic client with an API key.
   */
  initialize(apiKey: string): void {
    this.client = new Anthropic({
      apiKey,
      timeout: this.defaultTimeout,
      // BACKLOG-3799: Chromium network stack (OS trust store / system proxy)
      fetch: mainNetFetch as unknown as typeof fetch,
    });
  }

  /**
   * Complete a chat conversation using Anthropic Claude.
   */
  async complete(messages: LLMMessage[], config: LLMConfig): Promise<LLMResponse> {
    if (!this.client) {
      throw this.createError(
        'Anthropic client not initialized. Call initialize() first.',
        'invalid_api_key',
        401,
        false
      );
    }

    const startTime = Date.now();

    // Extract system message (Anthropic handles system separately)
    const systemMessage = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    try {
      const response = await this.client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens ?? 1000,
        system: systemMessage?.content,
        messages: chatMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
      });

      const latencyMs = Date.now() - startTime;

      // Extract text content from response (may have multiple blocks)
      const textContent = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        content: textContent,
        tokensUsed: {
          prompt: response.usage.input_tokens,
          completion: response.usage.output_tokens,
          total: response.usage.input_tokens + response.usage.output_tokens,
        },
        model: response.model,
        finishReason: this.mapStopReason(response.stop_reason),
        latencyMs,
      };
    } catch (error) {
      throw this.handleAnthropicError(error);
    }
  }

  /**
   * Validate an API key by making a minimal API call.
   * Anthropic doesn't have a models.list endpoint, so we make a minimal completion.
   */
  async validateApiKey(apiKey: string): Promise<boolean> {
    const testClient = new Anthropic({
      apiKey,
      timeout: 10000, // 10 second timeout for validation
    });

    try {
      // Make a minimal completion to validate key
      await testClient.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      });
      return true;
    } catch (error) {
      // Check for authentication error by status code
      if (this.isAnthropicAPIError(error) && error.status === 401) {
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
   * Map Anthropic errors to our error types.
   */
  private handleAnthropicError(error: unknown): LLMError {
    // Check if it's an Anthropic API error by checking for status property
    if (this.isAnthropicAPIError(error)) {
      const type = this.mapAnthropicErrorType(error);
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
   * Check if an error is an Anthropic API error.
   */
  private isAnthropicAPIError(
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

  private mapAnthropicErrorType(error: { status: number; message: string }): LLMErrorType {
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
        if (error.message.includes('context') || error.message.includes('too long')) {
          return 'context_length';
        }
        return 'unknown';
      default:
        return this.mapStatusToErrorType(error.status);
    }
  }

  private mapStopReason(reason: string | null): LLMResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }
}
