/**
 * @jest-environment node
 */

import log from 'electron-log';
import {
  LLMError,
  LLMErrorType,
  LLMProvider,
  LLMConfig,
  LLMResponse,
  LLMMessage,
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
} from '../types';
import { BaseLLMService, RetryConfig, DEFAULT_RETRY_CONFIG } from '../baseLLMService';

// Concrete implementation for testing abstract class
class TestLLMService extends BaseLLMService {
  public completeMock: jest.Mock;

  constructor(
    provider: LLMProvider = 'openai',
    requestsPerMinute: number = 60,
    retryConfig?: RetryConfig
  ) {
    super(provider, requestsPerMinute, retryConfig);
    this.completeMock = jest.fn().mockResolvedValue({
      content: 'test response',
      tokensUsed: { prompt: 10, completion: 20, total: 30 },
      model: 'gpt-4o-mini',
      finishReason: 'stop',
      latencyMs: 100,
    });
  }

  // Implement abstract methods
  async complete(
    messages: LLMMessage[],
    config: LLMConfig
  ): Promise<LLMResponse> {
    return this.completeMock(messages, config);
  }

  async validateApiKey(_apiKey: string): Promise<boolean> {
    return true;
  }

  // Expose protected methods for testing
  public testCreateError(
    message: string,
    type: LLMErrorType,
    statusCode?: number,
    retryable?: boolean,
    retryAfterMs?: number
  ): LLMError {
    return this.createError(message, type, statusCode, retryable, retryAfterMs);
  }

  public testMapStatusToErrorType(status: number): LLMErrorType {
    return this.mapStatusToErrorType(status);
  }

  public testIsRetryableError(type: LLMErrorType): boolean {
    return this.isRetryableError(type);
  }

  public testBuildSimplePrompt(
    systemPrompt: string,
    userMessage: string
  ): LLMMessage[] {
    return this.buildSimplePrompt(systemPrompt, userMessage);
  }

  public testLog(
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: unknown
  ): void {
    this.log(level, message, data);
  }
}

describe('BaseLLMService', () => {
  let service: TestLLMService;

  beforeEach(() => {
    service = new TestLLMService('openai');
  });

  describe('constructor and getProvider', () => {
    it('should set provider on construction', () => {
      expect(service.getProvider()).toBe('openai');
    });

    it('should allow different providers', () => {
      const anthropicService = new TestLLMService('anthropic');
      expect(anthropicService.getProvider()).toBe('anthropic');
    });
  });

  describe('createError', () => {
    it('should create an LLMError with all properties', () => {
      const error = service.testCreateError(
        'Test error',
        'rate_limit',
        429,
        true,
        5000
      );

      expect(error).toBeInstanceOf(LLMError);
      expect(error.message).toBe('Test error');
      expect(error.type).toBe('rate_limit');
      expect(error.provider).toBe('openai');
      expect(error.statusCode).toBe(429);
      expect(error.retryable).toBe(true);
      expect(error.retryAfterMs).toBe(5000);
      expect(error.name).toBe('LLMError');
    });

    it('should default retryable to false', () => {
      const error = service.testCreateError('Test error', 'unknown');
      expect(error.retryable).toBe(false);
    });

    it('should work without optional parameters', () => {
      const error = service.testCreateError('Test error', 'network');
      expect(error.statusCode).toBeUndefined();
      expect(error.retryAfterMs).toBeUndefined();
    });
  });

  describe('mapStatusToErrorType', () => {
    it('should map 401 to invalid_api_key', () => {
      expect(service.testMapStatusToErrorType(401)).toBe('invalid_api_key');
    });

    it('should map 429 to rate_limit', () => {
      expect(service.testMapStatusToErrorType(429)).toBe('rate_limit');
    });

    it('should map 402 to quota_exceeded', () => {
      expect(service.testMapStatusToErrorType(402)).toBe('quota_exceeded');
    });

    it('should map 403 to quota_exceeded', () => {
      expect(service.testMapStatusToErrorType(403)).toBe('quota_exceeded');
    });

    it('should map 400 to context_length', () => {
      expect(service.testMapStatusToErrorType(400)).toBe('context_length');
    });

    it('should map unknown status codes to unknown', () => {
      expect(service.testMapStatusToErrorType(500)).toBe('unknown');
      expect(service.testMapStatusToErrorType(503)).toBe('unknown');
      expect(service.testMapStatusToErrorType(404)).toBe('unknown');
    });
  });

  describe('isRetryableError', () => {
    it('should return true for rate_limit', () => {
      expect(service.testIsRetryableError('rate_limit')).toBe(true);
    });

    it('should return true for network', () => {
      expect(service.testIsRetryableError('network')).toBe(true);
    });

    it('should return true for timeout', () => {
      expect(service.testIsRetryableError('timeout')).toBe(true);
    });

    it('should return false for invalid_api_key', () => {
      expect(service.testIsRetryableError('invalid_api_key')).toBe(false);
    });

    it('should return false for quota_exceeded', () => {
      expect(service.testIsRetryableError('quota_exceeded')).toBe(false);
    });

    it('should return false for context_length', () => {
      expect(service.testIsRetryableError('context_length')).toBe(false);
    });

    it('should return false for content_filter', () => {
      expect(service.testIsRetryableError('content_filter')).toBe(false);
    });

    it('should return false for unknown', () => {
      expect(service.testIsRetryableError('unknown')).toBe(false);
    });
  });

  describe('buildSimplePrompt', () => {
    it('should build messages array with system and user roles', () => {
      const messages = service.testBuildSimplePrompt(
        'You are a helpful assistant.',
        'Hello, world!'
      );

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      });
      expect(messages[1]).toEqual({
        role: 'user',
        content: 'Hello, world!',
      });
    });

    it('should handle empty strings', () => {
      const messages = service.testBuildSimplePrompt('', '');

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('');
      expect(messages[1].content).toBe('');
    });
  });

  describe('log', () => {
    // logService.writeToConsole() routes through electron-log (BACKLOG-1843) so that
    // messages reach the file transport in packaged builds. Console spies no longer
    // capture logService output — assert via the electron-log mock instead.

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should log info messages with provider prefix', () => {
      service.testLog('info', 'Test message');
      expect(log.info).toHaveBeenCalled();
      const msg = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(msg).toContain('Test message');
      expect(msg).toContain('[LLM:openai]');
    });

    it('should log warn messages with provider prefix', () => {
      service.testLog('warn', 'Test warning');
      expect(log.warn).toHaveBeenCalled();
      const msg = (log.warn as jest.Mock).mock.calls[0][0] as string;
      expect(msg).toContain('Test warning');
      expect(msg).toContain('[LLM:openai]');
    });

    it('should log error messages with provider prefix', () => {
      service.testLog('error', 'Test error');
      expect(log.error).toHaveBeenCalled();
      const msg = (log.error as jest.Mock).mock.calls[0][0] as string;
      expect(msg).toContain('Test error');
      expect(msg).toContain('[LLM:openai]');
    });

    it('should include data when provided', () => {
      const data = { key: 'value' };
      service.testLog('info', 'Test with data', data);
      expect(log.info).toHaveBeenCalled();
      const msg = (log.info as jest.Mock).mock.calls[0][0] as string;
      expect(msg).toContain('Test with data');
      expect(msg).toContain('key');
      expect(msg).toContain('value');
    });
  });
});

describe('completeWithRetry', () => {
  let service: TestLLMService;
  const testMessages: LLMMessage[] = [{ role: 'user', content: 'test' }];
  const testConfig: LLMConfig = {
    provider: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    // Use fast retry config for testing
    const fastRetryConfig: RetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      backoffMultiplier: 2,
    };
    service = new TestLLMService('openai', 1000, fastRetryConfig);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should return result on successful first attempt', async () => {
    const result = await service.completeWithRetry(testMessages, testConfig);

    expect(result.content).toBe('test response');
    expect(service.completeMock).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable error and succeed', async () => {
    const retryableError = new LLMError(
      'Rate limited',
      'rate_limit',
      'openai',
      429,
      true
    );

    service.completeMock
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce({
        content: 'success after retry',
        tokensUsed: { prompt: 10, completion: 20, total: 30 },
        model: 'gpt-4o-mini',
        finishReason: 'stop',
        latencyMs: 100,
      });

    const resultPromise = service.completeWithRetry(testMessages, testConfig);

    // Advance past the retry delay
    await jest.advanceTimersByTimeAsync(100);

    const result = await resultPromise;

    expect(result.content).toBe('success after retry');
    expect(service.completeMock).toHaveBeenCalledTimes(2);
  });

  it('should not retry on non-retryable error', async () => {
    const nonRetryableError = new LLMError(
      'Invalid API key',
      'invalid_api_key',
      'openai',
      401,
      false
    );

    service.completeMock.mockRejectedValueOnce(nonRetryableError);

    await expect(
      service.completeWithRetry(testMessages, testConfig)
    ).rejects.toThrow('Invalid API key');

    expect(service.completeMock).toHaveBeenCalledTimes(1);
  });

  it('should throw after all retries exhausted', async () => {
    // Use real timers for this test with minimal retry config
    jest.useRealTimers();

    const minimalRetryConfig: RetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 10,
      backoffMultiplier: 2,
    };
    const testService = new TestLLMService('openai', 1000, minimalRetryConfig);

    const retryableError = new LLMError(
      'Rate limited',
      'rate_limit',
      'openai',
      429,
      true
    );

    testService.completeMock.mockRejectedValue(retryableError);

    await expect(
      testService.completeWithRetry(testMessages, testConfig)
    ).rejects.toThrow('Rate limited');

    expect(testService.completeMock).toHaveBeenCalledTimes(3);
  });

  it('should honor Retry-After header when provided', async () => {
    const retryableErrorWithRetryAfter = new LLMError(
      'Rate limited',
      'rate_limit',
      'openai',
      429,
      true,
      500 // retryAfterMs
    );

    service.completeMock
      .mockRejectedValueOnce(retryableErrorWithRetryAfter)
      .mockResolvedValueOnce({
        content: 'success after retry',
        tokensUsed: { prompt: 10, completion: 20, total: 30 },
        model: 'gpt-4o-mini',
        finishReason: 'stop',
        latencyMs: 100,
      });

    const resultPromise = service.completeWithRetry(testMessages, testConfig);

    // Should wait 500ms (Retry-After), not the default 100ms
    await jest.advanceTimersByTimeAsync(500);

    const result = await resultPromise;

    expect(result.content).toBe('success after retry');
    expect(service.completeMock).toHaveBeenCalledTimes(2);
  });

  it('should wrap unexpected errors', async () => {
    service.completeMock.mockRejectedValueOnce(new Error('Unexpected error'));

    await expect(
      service.completeWithRetry(testMessages, testConfig)
    ).rejects.toThrow('Unexpected error');
  });

  it('should use exponential backoff', async () => {
    // Use real timers with minimal config
    jest.useRealTimers();

    const minimalRetryConfig: RetryConfig = {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 10,
      backoffMultiplier: 2,
    };
    const testService = new TestLLMService('openai', 1000, minimalRetryConfig);

    const retryableError = new LLMError(
      'Network error',
      'network',
      'openai',
      undefined,
      true
    );

    testService.completeMock.mockRejectedValue(retryableError);

    await expect(
      testService.completeWithRetry(testMessages, testConfig)
    ).rejects.toThrow();

    expect(testService.completeMock).toHaveBeenCalledTimes(3);
  });
});

describe('rate limiting methods', () => {
  let service: TestLLMService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new TestLLMService('openai', 60);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('isRateLimited should return false when tokens available', () => {
    expect(service.isRateLimited()).toBe(false);
  });

  it('getWaitTime should return 0 when tokens available', () => {
    expect(service.getWaitTime()).toBe(0);
  });
});

describe('DEFAULT_RETRY_CONFIG', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBe(1000);
    expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(30000);
    expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
  });
});

describe('LLMError', () => {
  it('should be an instance of Error', () => {
    const error = new LLMError('Test', 'rate_limit', 'openai');
    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct name property', () => {
    const error = new LLMError('Test', 'rate_limit', 'openai');
    expect(error.name).toBe('LLMError');
  });

  it('should store all properties correctly', () => {
    const error = new LLMError(
      'Rate limited',
      'rate_limit',
      'anthropic',
      429,
      true,
      10000
    );

    expect(error.message).toBe('Rate limited');
    expect(error.type).toBe('rate_limit');
    expect(error.provider).toBe('anthropic');
    expect(error.statusCode).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(10000);
  });
});

describe('Model Constants', () => {
  describe('OPENAI_MODELS', () => {
    it('should have gpt-4o-mini model', () => {
      expect(OPENAI_MODELS['gpt-4o-mini']).toBeDefined();
      expect(OPENAI_MODELS['gpt-4o-mini'].contextWindow).toBe(128000);
    });

    it('should have gpt-4o model', () => {
      expect(OPENAI_MODELS['gpt-4o']).toBeDefined();
    });

    it('should have gpt-4-turbo model', () => {
      expect(OPENAI_MODELS['gpt-4-turbo']).toBeDefined();
    });

    it('should have cost information for all models', () => {
      Object.values(OPENAI_MODELS).forEach((model) => {
        expect(model.costPer1kInput).toBeDefined();
        expect(model.costPer1kOutput).toBeDefined();
        expect(typeof model.costPer1kInput).toBe('number');
        expect(typeof model.costPer1kOutput).toBe('number');
      });
    });
  });

  describe('ANTHROPIC_MODELS', () => {
    it('should have claude-3-haiku model', () => {
      expect(ANTHROPIC_MODELS['claude-3-haiku-20240307']).toBeDefined();
      expect(ANTHROPIC_MODELS['claude-3-haiku-20240307'].contextWindow).toBe(
        200000
      );
    });

    it('should have claude-3-5-sonnet model', () => {
      expect(ANTHROPIC_MODELS['claude-3-5-sonnet-20241022']).toBeDefined();
    });

    it('should have claude-3-opus model', () => {
      expect(ANTHROPIC_MODELS['claude-3-opus-20240229']).toBeDefined();
    });

    it('should have cost information for all models', () => {
      Object.values(ANTHROPIC_MODELS).forEach((model) => {
        expect(model.costPer1kInput).toBeDefined();
        expect(model.costPer1kOutput).toBeDefined();
        expect(typeof model.costPer1kInput).toBe('number');
        expect(typeof model.costPer1kOutput).toBe('number');
      });
    });
  });
});
