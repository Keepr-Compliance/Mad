/**
 * Hybrid Extractor Service
 * TASK-320: Combines pattern matching and LLM-based extraction
 *
 * This service orchestrates:
 * 1. Pattern matching (via transactionExtractorService) - fast, no API cost
 * 2. LLM analysis (via AI tools) - contextual, higher accuracy
 *
 * Key principles:
 * - Pattern matching always runs first (fail-fast for non-RE emails)
 * - LLM errors never break the extraction pipeline
 * - Results are merged with weighted confidence (LLM 60%, Pattern 40%)
 * - Tools are initialized lazily to avoid unnecessary instantiation
 */

import { v4 as uuidv4 } from 'uuid';
import transactionExtractorService, {
  AnalysisResult,
} from '../transactionExtractorService';
import { AnalyzeMessageTool } from '../llm/tools/analyzeMessageTool';
import { ExtractContactRolesTool } from '../llm/tools/extractContactRolesTool';
import { ClusterTransactionsTool } from '../llm/tools/clusterTransactionsTool';
import { OpenAIService } from '../llm/openAIService';
import { AnthropicService } from '../llm/anthropicService';
import { LLMConfigService } from '../llm/llmConfigService';
import { ContentSanitizer } from '../llm/contentSanitizer';
import { LLMConfig, LLMProvider } from '../llm/types';
import { MessageAnalysis, ContactRoleExtraction } from '../llm/tools/types';
import type { Contact } from '../../types';
import {
  AnalyzedMessage,
  DetectedTransaction,
  HybridExtractionOptions,
  HybridExtractionResult,
  ExtractionMethod,
  MessageInput,
  ExistingTransactionRef,
  PatternSummary,
  SpamFilterStats,
  OptimizedAnalysisResult,
  CONFIDENCE_WEIGHTS,
  DEFAULT_EXTRACTION_OPTIONS,
} from './types';
import {
  createBatches,
  formatBatchPrompt,
  parseBatchResponse,
  processBatchErrors,
  BatchAnalysisResult,
  BatchParseResult,
  EmailBatch,
} from '../llm/batchLLMService';
import { BATCH_ANALYSIS_SYSTEM_PROMPT } from '../llm/prompts/batchAnalysis';
import {
  isGmailSpam,
  isOutlookJunk,
  SpamFilterResult,
} from '../llm/spamFilterService';
import {
  groupEmailsByThread,
  getFirstEmailsFromThreads,
  getEmailsToPropagate,
  findThreadByEmailId,
  ThreadGroupingResult,
  PropagationResult,
} from '../llm/threadGroupingService';
import logService from '../logService';

/**
 * Hybrid Extractor Service
 * Combines pattern matching and LLM analysis for transaction detection.
 */
export class HybridExtractorService {
  private openAIService: OpenAIService | null = null;
  private anthropicService: AnthropicService | null = null;
  private configService: LLMConfigService;
  private sanitizer: ContentSanitizer;

  // Lazy-initialized tools
  private analyzeMessageTool: AnalyzeMessageTool | null = null;
  private extractContactRolesTool: ExtractContactRolesTool | null = null;
  private clusterTransactionsTool: ClusterTransactionsTool | null = null;

  // Track total tokens used across operations
  private totalTokensUsed = { prompt: 0, completion: 0, total: 0 };

  // TASK-505: Store thread grouping for propagation (TASK-506)
  private threadGroupingResult: ThreadGroupingResult | null = null;

  constructor(configService?: LLMConfigService) {
    this.configService = configService ?? new LLMConfigService();
    this.sanitizer = new ContentSanitizer();
  }

  /**
   * Initialize LLM tools with the appropriate provider.
   * Lazy initialization to avoid unnecessary API client creation.
   */
  private initializeTools(provider: LLMProvider, apiKey: string): void {
    const service = this.getOrCreateService(provider, apiKey);

    this.analyzeMessageTool = new AnalyzeMessageTool(service);
    this.extractContactRolesTool = new ExtractContactRolesTool(service);
    this.clusterTransactionsTool = new ClusterTransactionsTool(service);
  }

  /**
   * Get or create the LLM service for a provider.
   */
  private getOrCreateService(
    provider: LLMProvider,
    apiKey: string
  ): OpenAIService | AnthropicService {
    if (provider === 'openai') {
      if (!this.openAIService) {
        this.openAIService = new OpenAIService();
      }
      this.openAIService.initialize(apiKey);
      return this.openAIService;
    } else {
      if (!this.anthropicService) {
        this.anthropicService = new AnthropicService();
      }
      this.anthropicService.initialize(apiKey);
      return this.anthropicService;
    }
  }

  /**
   * Reset token tracking for a new extraction session.
   */
  private resetTokenTracking(): void {
    this.totalTokensUsed = { prompt: 0, completion: 0, total: 0 };
  }

  /**
   * Add tokens to the running total.
   */
  private addTokens(tokens?: { prompt: number; completion: number; total: number }): void {
    if (tokens) {
      this.totalTokensUsed.prompt += tokens.prompt;
      this.totalTokensUsed.completion += tokens.completion;
      this.totalTokensUsed.total += tokens.total;
    }
  }

  // ===========================================================================
  // Spam Filtering (TASK-503)
  // ===========================================================================

  /**
   * Check if a message should be filtered as spam.
   * Checks Gmail labels or Outlook folder.
   */
  private checkSpam(message: MessageInput): SpamFilterResult {
    // Gmail check - if labels are present
    if (message.labels && message.labels.length > 0) {
      return isGmailSpam(message.labels);
    }

    // Outlook check - if folder info is present
    if (message.parentFolderName) {
      return isOutlookJunk({
        inferenceClassification: message.inferenceClassification,
        parentFolderName: message.parentFolderName,
      });
    }

    return { isSpam: false };
  }

  /**
   * Filter out spam messages before processing.
   * Returns non-spam messages and filtering stats.
   */
  filterSpam(messages: MessageInput[]): {
    filtered: MessageInput[];
    stats: SpamFilterStats;
  } {
    const filtered: MessageInput[] = [];
    let gmailSpam = 0;
    let outlookJunk = 0;

    for (const message of messages) {
      const spamResult = this.checkSpam(message);
      if (spamResult.isSpam) {
        // Track which provider detected the spam
        if (spamResult.reason?.includes('Gmail')) {
          gmailSpam++;
        } else if (spamResult.reason?.includes('Outlook')) {
          outlookJunk++;
        }
        logService.debug('Skipping spam email', 'HybridExtractor', {
          messageId: message.id,
          reason: spamResult.reason,
        });
      } else {
        filtered.push(message);
      }
    }

    const spamFiltered = gmailSpam + outlookJunk;
    const stats: SpamFilterStats = {
      totalEmails: messages.length,
      spamFiltered,
      gmailSpam,
      outlookJunk,
      percentFiltered: messages.length > 0
        ? Math.round((spamFiltered / messages.length) * 100)
        : 0,
    };

    logService.info('Spam filter results', 'HybridExtractor', {
      total: messages.length,
      processed: filtered.length,
      skippedSpam: spamFiltered,
    });

    return { filtered, stats };
  }

  // ===========================================================================
  // Thread Grouping (TASK-505)
  // ===========================================================================

  /**
   * Get the thread grouping result from the last analysis.
   * Used for transaction propagation in TASK-506.
   */
  getThreadGroupingResult(): ThreadGroupingResult | null {
    return this.threadGroupingResult;
  }

  /**
   * Group messages by thread and return only first emails for analysis.
   * Stores the grouping result for later propagation.
   */
  groupAndSelectFirstEmails(messages: MessageInput[]): {
    emailsToAnalyze: MessageInput[];
    stats: {
      totalEmails: number;
      totalThreads: number;
      emailsToAnalyze: number;
      reductionPercent: number;
    };
  } {
    // Convert MessageInput to Message-like for grouping
    // The grouping only needs id, thread_id, and date fields
    const messagesForGrouping = messages.map((m) => ({
      id: m.id,
      thread_id: m.thread_id,
      sent_at: m.date,
      received_at: m.date,
      created_at: m.date,
    }));

    this.threadGroupingResult = groupEmailsByThread(messagesForGrouping as any);

    const firstEmailIds = new Set(
      getFirstEmailsFromThreads(this.threadGroupingResult).map((e) => e.id)
    );

    // Filter original messages to only first emails
    const emailsToAnalyze = messages.filter((m) => firstEmailIds.has(m.id));

    const stats = {
      totalEmails: messages.length,
      totalThreads: this.threadGroupingResult.stats.totalThreads,
      emailsToAnalyze: emailsToAnalyze.length,
      reductionPercent:
        messages.length > 0
          ? Math.round((1 - emailsToAnalyze.length / messages.length) * 100)
          : 0,
    };

    logService.info('Thread grouping results', 'HybridExtractor', {
      totalEmails: stats.totalEmails,
      threads: stats.totalThreads,
      orphans: this.threadGroupingResult.stats.orphanCount,
      avgPerThread: this.threadGroupingResult.stats.avgEmailsPerThread.toFixed(1),
    });

    logService.info('Emails to analyze (first per thread)', 'HybridExtractor', {
      original: messages.length,
      toAnalyze: emailsToAnalyze.length,
      reduction: `${stats.reductionPercent}%`,
    });

    return { emailsToAnalyze, stats };
  }

  // ===========================================================================
  // Transaction Propagation (TASK-506)
  // ===========================================================================

  /**
   * Propagate transaction detection to all emails in the same thread.
   * Uses DetectedTransaction[] from clustering (not raw AnalysisResult[]).
   *
   * When a transaction is detected from the first email of a thread,
   * this links all other emails in that thread to the same transaction.
   */
  async propagateTransactionsToThreads(
    detectedTransactions: DetectedTransaction[],
    threadGrouping: ThreadGroupingResult
  ): Promise<PropagationResult[]> {
    const propagationResults: PropagationResult[] = [];

    for (const transaction of detectedTransactions) {
      // Get the first email that was analyzed (communication that triggered detection)
      const analyzedEmailId = transaction.communicationIds[0];
      if (!analyzedEmailId) continue;

      // Find which thread this email belongs to
      const threadId = findThreadByEmailId(threadGrouping, analyzedEmailId);
      if (!threadId) continue;

      // Get other emails in this thread that weren't analyzed
      const emailsToPropagate = getEmailsToPropagate(threadGrouping, threadId);
      if (emailsToPropagate.length === 0) continue;

      // Check existing links before overwriting (per SR Engineer review)
      const safeToPropagate = await this.filterAlreadyLinked(
        emailsToPropagate,
        transaction.id
      );

      if (safeToPropagate.length > 0) {
        // Link all thread emails to this transaction
        await this.linkEmailsToTransaction(safeToPropagate, transaction.id);

        propagationResults.push({
          transactionId: transaction.id,
          threadId: threadId,
          sourceEmailId: analyzedEmailId,
          propagatedEmailIds: safeToPropagate,
          propagatedCount: safeToPropagate.length,
        });
      }
    }

    logService.info('Transaction propagation complete', 'HybridExtractor', {
      transactionsFound: detectedTransactions.length,
      threadsPropagated: propagationResults.length,
      emailsLinked: propagationResults.reduce((sum, p) => sum + p.propagatedCount, 0),
    });

    return propagationResults;
  }

  /**
   * Filter out emails already linked to a different transaction.
   * Prevents overwriting existing transaction links.
   */
  private async filterAlreadyLinked(
    emailIds: string[],
    transactionId: string
  ): Promise<string[]> {
    // Lazy import to avoid circular dependencies
    //
    // BACKLOG-3067: `as typeof import(...)`. A bare `require()` returns `any`, so
    // EVERY call made through it was unchecked — which is why nothing in the
    // toolchain ever saw BACKLOG-2829 sitting four lines below its twin. This is a
    // type-only annotation: the `require` still happens lazily at call time, so the
    // circular-dependency workaround above is intact and the runtime is unchanged.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCommunicationById } = require('../db/communicationDbService') as typeof import('../db/communicationDbService');

    const safeIds: string[] = [];

    for (const emailId of emailIds) {
      try {
        const existing = await getCommunicationById(emailId);
        if (!existing?.transaction_id || existing.transaction_id === transactionId) {
          safeIds.push(emailId);
        } else {
          logService.warn('Email already linked to different transaction', 'HybridExtractor', {
            emailId,
            existingTransactionId: existing.transaction_id,
            newTransactionId: transactionId,
          });
        }
      } catch {
        // If we can't check, assume it's safe to link
        safeIds.push(emailId);
      }
    }

    return safeIds;
  }

  /**
   * Link emails to a transaction in the database.
   */
  private async linkEmailsToTransaction(
    emailIds: string[],
    transactionId: string
  ): Promise<void> {
    // Lazy import to avoid circular dependencies
    //
    // BACKLOG-3067: typed, for the reason given in `filterAlreadyLinked` above —
    // without the annotation the call below is made on `any` and no brand can
    // reach it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { linkCommunicationToTransaction } = require('../db/communicationDbService') as typeof import('../db/communicationDbService');

    for (const emailId of emailIds) {
      try {
        // BACKLOG-2829 — KNOWN LIVE DEFECT, deliberately NOT fixed here.
        //
        // `emailId` is an id from the `emails` table. The parameter wants a
        // `communications.id`. The UPDATE therefore matches zero rows and the
        // `logService.debug('Linked email to transaction')` below fires anyway.
        // Before BACKLOG-3067 branded these ids, both were `string` and nothing
        // in the toolchain could say so; this directive is the compiler finally
        // saying it, and being told to hold that thought.
        //
        // Why `@ts-expect-error` and not `asCommunicationId(emailId)`: the helper
        // would ASSERT that this email id is a communication id, which is false —
        // and false is the exact claim this line exists to record. This directive
        // also SELF-REMOVES: when 2829 is fixed and the types line up, TypeScript
        // reports TS2578 "unused '@ts-expect-error'" and CI stays red until the
        // comment is deleted. The ratchet is in the language, not in anyone's memory.
        //
        // 2829's fix is specified and must ship as specified: correct the predicate
        // AND update both transactions' stored thread counts, pinned together —
        // this is the one write path that calls neither `updateTransactionThreadCount`,
        // and correcting the predicate alone turns that latent drift live.
        // @ts-expect-error BACKLOG-2829: an email id is passed where a communication id belongs.
        await linkCommunicationToTransaction(emailId, transactionId);
        logService.debug('Linked email to transaction', 'HybridExtractor', {
          emailId,
          transactionId,
        });
      } catch (error) {
        logService.warn('Failed to link email to transaction', 'HybridExtractor', {
          emailId,
          transactionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Analyze messages using hybrid approach.
   * Always runs pattern matching first, then optionally LLM analysis.
   */
  async analyzeMessages(
    messages: MessageInput[],
    options: HybridExtractionOptions
  ): Promise<AnalyzedMessage[]> {
    const results: AnalyzedMessage[] = [];

    // Get LLM config once for all messages if LLM is enabled
    let llmConfig: LLMConfig | null = null;
    if (options.useLLM && options.userId) {
      llmConfig = await this.getLLMConfig(options);
      if (llmConfig) {
        this.initializeTools(llmConfig.provider, llmConfig.apiKey);
      }
    }

    for (const msg of messages) {
      const analyzed: AnalyzedMessage = {
        id: msg.id,
        subject: msg.subject,
        sender: msg.sender,
        recipients: msg.recipients,
        date: msg.date,
        body: msg.body,
        isRealEstateRelated: false,
        confidence: 0,
        extractionMethod: 'pattern',
      };

      // Step 1: Pattern matching (always runs if enabled, fast and free)
      if (options.usePatternMatching) {
        const patternResult = transactionExtractorService.analyzeEmail({
          subject: msg.subject,
          body: msg.body,
          from: msg.sender,
          to: msg.recipients.join(', '),
          date: msg.date,
        });

        analyzed.patternAnalysis = patternResult;
        analyzed.isRealEstateRelated = patternResult.isRealEstateRelated;
        analyzed.confidence = patternResult.confidence / 100; // Normalize to 0-1
      }

      // Step 2: LLM analysis (if enabled and configured)
      if (options.useLLM && llmConfig && this.analyzeMessageTool) {
        try {
          const llmResult = await this.runLLMAnalysis(msg, llmConfig);
          if (llmResult) {
            analyzed.llmAnalysis = llmResult.data;
            analyzed.extractionMethod = options.usePatternMatching ? 'hybrid' : 'llm';

            // Merge results - LLM takes precedence for classification
            if (llmResult.data) {
              analyzed.isRealEstateRelated = llmResult.data.isRealEstateRelated;
              analyzed.confidence = this.mergeConfidence(
                analyzed.patternAnalysis?.confidence,
                llmResult.data.confidence
              );
            }

            // Track tokens
            this.addTokens(llmResult.tokensUsed);
          }
        } catch (error) {
          // LLM errors should never break the pipeline
          logService.warn('[HybridExtractor] LLM analysis failed, using pattern only', 'HybridExtractor', { error });
        }
      }

      results.push(analyzed);
    }

    return results;
  }

  /**
   * Cluster analyzed messages into detected transactions.
   * Attempts LLM clustering first, falls back to pattern-based grouping.
   */
  async clusterIntoTransactions(
    analyzedMessages: AnalyzedMessage[],
    existingTransactions: ExistingTransactionRef[],
    options: HybridExtractionOptions
  ): Promise<DetectedTransaction[]> {
    // Filter to real estate related messages only
    const reMessages = analyzedMessages.filter((m) => m.isRealEstateRelated);

    if (reMessages.length === 0) {
      return [];
    }

    // Try LLM clustering first if enabled
    if (options.useLLM && this.clusterTransactionsTool && options.userId) {
      try {
        const llmConfig = await this.getLLMConfig(options);
        if (llmConfig) {
          const clusterInput = {
            analyzedMessages: reMessages.map((m) => ({
              id: m.id,
              subject: m.subject,
              sender: m.sender,
              recipients: m.recipients,
              date: m.date,
              analysis: m.llmAnalysis ?? this.convertPatternToLLMFormat(m.patternAnalysis!),
            })),
            existingTransactions: existingTransactions.map((t) => ({
              id: t.id,
              propertyAddress: t.propertyAddress,
              transactionType: t.transactionType,
            })),
          };

          const result = await this.clusterTransactionsTool.cluster(clusterInput, llmConfig);
          this.addTokens(result.tokensUsed);

          if (result.success && result.data) {
            return result.data.clusters.map((cluster) => ({
              id: uuidv4(),
              propertyAddress: cluster.propertyAddress,
              transactionType: cluster.transactionType,
              stage: cluster.stage,
              confidence: cluster.confidence,
              extractionMethod: 'hybrid' as ExtractionMethod,
              communicationIds: cluster.communicationIds,
              dateRange: cluster.dateRange,
              suggestedContacts: {
                assignments: cluster.suggestedContacts.map((c) => ({
                  name: c.name,
                  email: c.email,
                  role: (c.role as ContactRoleExtraction['assignments'][0]['role']) || 'other',
                  confidence: 0.7,
                  evidence: [],
                })),
              },
              summary: cluster.summary,
              cluster,
            }));
          }
        }
      } catch (error) {
        logService.warn('[HybridExtractor] LLM clustering failed, using pattern grouping', 'HybridExtractor', { error });
      }
    }

    // Fallback: Use pattern-based grouping
    return this.patternBasedClustering(reMessages);
  }

  /**
   * Extract contact roles for a detected transaction.
   * Uses LLM if available, otherwise returns existing contacts.
   */
  async extractContactRoles(
    cluster: DetectedTransaction,
    messages: AnalyzedMessage[],
    knownContacts: Contact[],
    options: HybridExtractionOptions
  ): Promise<DetectedTransaction> {
    if (!options.useLLM || !this.extractContactRolesTool || !options.userId) {
      return cluster;
    }

    try {
      const llmConfig = await this.getLLMConfig(options);
      if (!llmConfig) {
        return cluster;
      }

      const clusterMessages = messages.filter((m) =>
        cluster.communicationIds.includes(m.id)
      );

      const input = {
        communications: clusterMessages.map((m) => ({
          subject: m.subject,
          body: this.sanitizer.sanitize(m.body).sanitizedContent,
          sender: m.sender,
          recipients: m.recipients,
          date: m.date,
        })),
        knownContacts: knownContacts.map((c) => ({
          name: c.display_name || c.name || c.email || '',
          email: c.email || undefined,
          phone: c.phone || undefined,
        })),
        propertyAddress: cluster.propertyAddress,
      };

      const result = await this.extractContactRolesTool.extract(input, llmConfig);
      this.addTokens(result.tokensUsed);

      if (result.success && result.data) {
        return {
          ...cluster,
          suggestedContacts: result.data,
        };
      }
    } catch (error) {
      logService.warn('[HybridExtractor] Contact role extraction failed', 'HybridExtractor', { error });
    }

    return cluster;
  }

  /**
   * Full extraction pipeline.
   * Orchestrates message analysis, clustering, and contact extraction.
   */
  async extract(
    messages: MessageInput[],
    existingTransactions: ExistingTransactionRef[],
    knownContacts: Contact[],
    options: Partial<HybridExtractionOptions> = {}
  ): Promise<HybridExtractionResult> {
    const startTime = Date.now();
    const mergedOptions: HybridExtractionOptions = {
      ...DEFAULT_EXTRACTION_OPTIONS,
      ...options,
    };

    let llmUsed = false;
    let llmError: string | undefined;

    // Reset token tracking for this extraction session
    this.resetTokenTracking();

    try {
      // Check if LLM is available and configured
      if (mergedOptions.useLLM && mergedOptions.userId) {
        const llmConfig = await this.getLLMConfig(mergedOptions);
        if (llmConfig) {
          this.initializeTools(llmConfig.provider, llmConfig.apiKey);
          llmUsed = true;
        } else {
          // LLM not configured, continue with pattern only
          mergedOptions.useLLM = false;
        }
      }

      // Step 1: Analyze all messages
      const analyzedMessages = await this.analyzeMessages(messages, mergedOptions);

      // Step 2: Cluster into transactions
      let detectedTransactions = await this.clusterIntoTransactions(
        analyzedMessages,
        existingTransactions,
        mergedOptions
      );

      // Step 3: Extract contact roles for each cluster
      if (mergedOptions.useLLM && llmUsed) {
        detectedTransactions = await Promise.all(
          detectedTransactions.map((tx) =>
            this.extractContactRoles(tx, analyzedMessages, knownContacts, mergedOptions)
          )
        );
      }

      const extractionMethod: ExtractionMethod =
        mergedOptions.usePatternMatching && llmUsed
          ? 'hybrid'
          : llmUsed
            ? 'llm'
            : 'pattern';

      return {
        success: true,
        analyzedMessages,
        detectedTransactions,
        extractionMethod,
        llmUsed,
        tokensUsed: llmUsed ? { ...this.totalTokensUsed } : undefined,
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      llmError = error instanceof Error ? error.message : 'Unknown error';

      // Fallback to pattern-only extraction
      const patternOnlyOptions = { ...mergedOptions, useLLM: false };
      const analyzedMessages = await this.analyzeMessages(messages, patternOnlyOptions);
      const detectedTransactions = await this.clusterIntoTransactions(
        analyzedMessages,
        existingTransactions,
        patternOnlyOptions
      );

      return {
        success: true, // Still successful with fallback
        analyzedMessages,
        detectedTransactions,
        extractionMethod: 'pattern',
        llmUsed: false,
        llmError,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Run LLM analysis on a single message.
   */
  private async runLLMAnalysis(
    msg: MessageInput,
    config: LLMConfig
  ): Promise<{ data?: MessageAnalysis; tokensUsed?: { prompt: number; completion: number; total: number } } | null> {
    if (!this.analyzeMessageTool) {
      return null;
    }

    const result = await this.analyzeMessageTool.analyze(
      {
        subject: msg.subject,
        body: msg.body,
        sender: msg.sender,
        recipients: msg.recipients,
        date: msg.date,
      },
      config
    );

    if (result.success && result.data) {
      return {
        data: result.data,
        tokensUsed: result.tokensUsed,
      };
    }

    return null;
  }

  /**
   * Get LLM configuration for the user.
   * Returns null if LLM is not configured.
   */
  private async getLLMConfig(options: HybridExtractionOptions): Promise<LLMConfig | null> {
    if (!options.userId) {
      return null;
    }

    try {
      const userConfig = await this.configService.getUserConfig(options.userId);

      // Check if user has consent and available tokens
      if (!userConfig.hasConsent) {
        return null;
      }

      // Determine which provider to use
      const provider = options.llmProvider ?? userConfig.preferredProvider;

      // Check if the provider has an API key configured
      const hasKey =
        (provider === 'openai' && userConfig.hasOpenAI) ||
        (provider === 'anthropic' && userConfig.hasAnthropic);

      if (!hasKey) {
        return null;
      }

      // Get the actual API key by using the config service's internal method
      // Note: We need to get the decrypted key, which requires accessing
      // the LLM settings directly. For now, we'll use a workaround by
      // triggering a validation which initializes the service.
      const settings = await this.getDecryptedApiKey(options.userId, provider);
      if (!settings) {
        return null;
      }

      return {
        provider,
        apiKey: settings,
        model: provider === 'openai' ? userConfig.openAIModel : userConfig.anthropicModel,
        maxTokens: 1500,
        temperature: 0.1,
      };
    } catch (error) {
      logService.warn('[HybridExtractor] Failed to get LLM config', 'HybridExtractor', { error });
      return null;
    }
  }

  /**
   * Get decrypted API key for a provider.
   * This is a workaround since LLMConfigService doesn't expose raw keys.
   */
  private async getDecryptedApiKey(
    userId: string,
    provider: LLMProvider
  ): Promise<string | null> {
    // Import the database service and token encryption
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLLMSettingsByUserId } = require('../db/llmSettingsDbService');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tokenEncryptionService = require('../tokenEncryptionService').default;

    try {
      const settings = getLLMSettingsByUserId(userId);
      if (!settings) {
        return null;
      }

      const encryptedKey =
        provider === 'openai'
          ? settings.openai_api_key_encrypted
          : settings.anthropic_api_key_encrypted;

      if (!encryptedKey) {
        return null;
      }

      return tokenEncryptionService.decrypt(encryptedKey);
    } catch (error) {
      logService.warn('[HybridExtractor] Failed to decrypt API key', 'HybridExtractor', { error });
      return null;
    }
  }

  /**
   * Merge confidence scores from pattern matching and LLM.
   * Uses weighted average: LLM 60%, Pattern 40%.
   */
  private mergeConfidence(
    patternConfidence: number | undefined,
    llmConfidence: number
  ): number {
    if (patternConfidence === undefined) {
      return llmConfidence;
    }

    // Pattern confidence is 0-100, normalize to 0-1
    const normalizedPatternConfidence = patternConfidence / 100;

    // Weighted average
    return (
      llmConfidence * CONFIDENCE_WEIGHTS.llm +
      normalizedPatternConfidence * CONFIDENCE_WEIGHTS.pattern
    );
  }

  /**
   * Convert pattern analysis result to LLM format for clustering.
   */
  private convertPatternToLLMFormat(patternResult: AnalysisResult): MessageAnalysis {
    return {
      isRealEstateRelated: patternResult.isRealEstateRelated,
      confidence: patternResult.confidence / 100,
      transactionIndicators: {
        type: patternResult.transactionType,
        stage: null,
      },
      extractedEntities: {
        addresses: patternResult.addresses.map((a) => ({
          value: a,
          confidence: 0.7,
        })),
        amounts: patternResult.amounts.map((a) => ({
          value: a,
          context: 'extracted',
        })),
        dates: patternResult.dates.map((d) => ({
          value: d,
          type: 'other' as const,
        })),
        contacts: patternResult.parties.map((p) => ({
          name: p.name || '',
          email: p.email,
          suggestedRole: p.role,
        })),
      },
      reasoning: 'Pattern matching analysis',
    };
  }

  /**
   * Pattern-based clustering fallback.
   * Uses transactionExtractorService.groupByProperty.
   */
  private patternBasedClustering(messages: AnalyzedMessage[]): DetectedTransaction[] {
    // Filter messages with pattern analysis
    const messagesWithPatterns = messages.filter((m) => m.patternAnalysis);

    if (messagesWithPatterns.length === 0) {
      return [];
    }

    // Group by property address
    const grouped = transactionExtractorService.groupByProperty(
      messagesWithPatterns.map((m) => m.patternAnalysis!)
    );

    // Convert to detected transactions
    return Object.entries(grouped)
      .map(([address, emails]) => {
        const summary = transactionExtractorService.generateTransactionSummary(emails);
        if (!summary) {
          return null;
        }

        const msgIds = messagesWithPatterns
          .filter((m) => m.patternAnalysis?.addresses.includes(address))
          .map((m) => m.id);

        const patternSummary: PatternSummary = {
          propertyAddress: summary.propertyAddress,
          transactionType: summary.transactionType,
          salePrice: summary.salePrice,
          closingDate: summary.closingDate,
          mlsNumbers: summary.mlsNumbers,
          communicationsCount: summary.communicationsCount,
          firstCommunication: summary.firstCommunication,
          lastCommunication: summary.lastCommunication,
          confidence: summary.confidence,
        };

        return {
          id: uuidv4(),
          propertyAddress: address,
          transactionType: summary.transactionType,
          stage: null,
          confidence: summary.confidence / 100,
          extractionMethod: 'pattern' as ExtractionMethod,
          communicationIds: msgIds,
          dateRange: {
            start: new Date(summary.firstCommunication).toISOString(),
            end: new Date(summary.lastCommunication).toISOString(),
          },
          suggestedContacts: { assignments: [] },
          summary: `Transaction at ${address} with ${summary.communicationsCount} communications`,
          patternSummary,
        } as DetectedTransaction;
      })
      .filter((tx): tx is DetectedTransaction => tx !== null);
  }

  // ===========================================================================
  // Optimized Pipeline (TASK-509)
  // ===========================================================================

  /** Current user ID for LLM config lookup */
  private currentUserId?: string;

  /**
   * Analyze messages using the optimized pipeline.
   * Combines spam filtering, thread grouping, and batching for cost efficiency.
   *
   * TASK-509: This is the new optimized entry point.
   */
  async analyzeMessagesOptimized(
    messages: MessageInput[],
    userId: string
  ): Promise<OptimizedAnalysisResult> {
    const startTime = Date.now();
    this.currentUserId = userId;

    try {
      // STEP 1: Spam Filter
      const { filtered: nonSpamMessages, stats: spamStats } = this.filterSpam(messages);

      logService.info('Step 1: Spam filtering complete', 'OptimizedPipeline', {
        original: messages.length,
        afterFilter: nonSpamMessages.length,
        spamRemoved: spamStats.spamFiltered,
      });

      // STEP 2: Thread Grouping
      const { emailsToAnalyze, stats: threadStats } = this.groupAndSelectFirstEmails(nonSpamMessages);

      logService.info('Step 2: Thread grouping complete', 'OptimizedPipeline', {
        threads: threadStats.totalThreads,
        emailsToAnalyze: emailsToAnalyze.length,
        reduction: `${threadStats.reductionPercent}%`,
      });

      // STEP 3: Batching
      const batchingResult = createBatches(emailsToAnalyze);

      logService.info('Step 3: Batching complete', 'OptimizedPipeline', {
        batches: batchingResult.stats.totalBatches,
        avgPerBatch: batchingResult.stats.avgEmailsPerBatch,
        estimatedTokens: batchingResult.stats.estimatedTotalTokens,
      });

      // STEP 4: Process Batches
      const allResults: BatchAnalysisResult[] = [];

      for (const batch of batchingResult.batches) {
        logService.debug(`Processing batch ${batch.batchId}`, 'OptimizedPipeline', {
          emailCount: batch.emails.length,
          estimatedTokens: batch.estimatedTokens,
        });

        const batchResult = await this.processBatch(batch, userId);
        allResults.push(...batchResult.results);

        // Handle errors with fallback
        if (batchResult.errors.length > 0) {
          logService.warn('Batch had errors, using fallback', 'OptimizedPipeline', {
            batchId: batch.batchId,
            errorCount: batchResult.errors.length,
          });
          const fallbackResults = await this.processFallback(batch, batchResult.errors);
          allResults.push(...fallbackResults);
        }
      }

      logService.info('Step 4: Batch processing complete', 'OptimizedPipeline', {
        totalResults: allResults.length,
        realEstateFound: allResults.filter((r) => r.isRealEstateRelated).length,
      });

      // STEP 5: Propagate to Threads
      // Convert BatchAnalysisResult to DetectedTransaction for propagation
      const detectedTransactions = this.convertToDetectedTransactions(allResults);
      const propagationResults = this.threadGroupingResult
        ? await this.propagateTransactionsToThreads(detectedTransactions, this.threadGroupingResult)
        : [];

      const endTime = Date.now();

      // Calculate cost reduction
      const originalApiCalls = messages.length;
      const actualApiCalls = batchingResult.stats.totalBatches;
      const costReductionPercent =
        originalApiCalls > 0
          ? ((1 - actualApiCalls / originalApiCalls) * 100).toFixed(1)
          : '0.0';

      logService.info('Step 5: Pipeline complete', 'OptimizedPipeline', {
        processingTimeMs: endTime - startTime,
        costReduction: `${costReductionPercent}%`,
        originalCalls: originalApiCalls,
        actualCalls: actualApiCalls,
      });

      return {
        success: true,
        results: allResults,
        propagation: propagationResults,
        stats: {
          originalEmails: messages.length,
          spamFiltered: spamStats.spamFiltered,
          threadsAnalyzed: batchingResult.stats.totalEmails,
          batchesSent: batchingResult.stats.totalBatches,
          realEstateFound: allResults.filter((r) => r.isRealEstateRelated).length,
          emailsLinkedByPropagation: propagationResults.reduce(
            (sum, p) => sum + p.propagatedCount,
            0
          ),
          processingTimeMs: endTime - startTime,
          costReductionPercent,
        },
      };
    } catch (error) {
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      logService.error('Optimized pipeline failed', 'OptimizedPipeline', {
        error: errorMessage,
        processingTimeMs: endTime - startTime,
      });

      return {
        success: false,
        results: [],
        propagation: [],
        stats: {
          originalEmails: messages.length,
          spamFiltered: 0,
          threadsAnalyzed: 0,
          batchesSent: 0,
          realEstateFound: 0,
          emailsLinkedByPropagation: 0,
          processingTimeMs: endTime - startTime,
          costReductionPercent: '0.0',
        },
        error: errorMessage,
      };
    }
  }

  /**
   * Process a batch of emails through LLM.
   */
  private async processBatch(batch: EmailBatch, userId: string): Promise<BatchParseResult> {
    const prompt = formatBatchPrompt(batch);

    // Get LLM config using existing pattern
    const llmConfig = await this.getLLMConfig({ userId, useLLM: true, usePatternMatching: true });
    if (!llmConfig) {
      // Return all errors if LLM not configured
      return {
        results: [],
        errors: batch.emails.map((e) => ({ emailId: e.id, error: 'LLM not configured' })),
        stats: { total: batch.emails.length, successful: 0, failed: batch.emails.length, realEstateFound: 0 },
      };
    }

    // Use existing service pattern
    const service = this.getOrCreateService(llmConfig.provider, llmConfig.apiKey);

    try {
      // Build messages array with system prompt and user prompt
      const messages = [
        { role: 'system' as const, content: BATCH_ANALYSIS_SYSTEM_PROMPT },
        { role: 'user' as const, content: prompt },
      ];

      // Call LLM with batch prompt
      const response = await service.complete(messages, {
        ...llmConfig,
        maxTokens: 4000,
        temperature: 0.1,
      });

      return parseBatchResponse(batch, response.content);
    } catch (error) {
      // Return all as errors if LLM call fails
      const errorMessage = error instanceof Error ? error.message : 'LLM call failed';
      return {
        results: [],
        errors: batch.emails.map((e) => ({ emailId: e.id, error: errorMessage })),
        stats: { total: batch.emails.length, successful: 0, failed: batch.emails.length, realEstateFound: 0 },
      };
    }
  }

  /**
   * Process failed batch emails individually.
   */
  private async processFallback(
    batch: EmailBatch,
    errors: Array<{ emailId: string; error: string }>
  ): Promise<BatchAnalysisResult[]> {
    const emailMap = new Map(batch.emails.map((e) => [e.id, e]));

    return processBatchErrors(errors, emailMap, async (email): Promise<BatchAnalysisResult> => {
      // Use pattern matching for fallback (no LLM cost)
      const patternResult = transactionExtractorService.analyzeEmail({
        subject: email.subject,
        body: email.body,
        from: email.sender,
        to: email.recipients.join(', '),
        date: email.date,
      });

      return {
        emailId: email.id,
        isRealEstateRelated: patternResult.isRealEstateRelated,
        confidence: patternResult.confidence / 100,
        transactionType: patternResult.transactionType || null,
        propertyAddress: patternResult.addresses[0] || undefined,
        reasoning: 'Pattern matching fallback',
      };
    });
  }

  /**
   * Convert batch analysis results to detected transactions for propagation.
   */
  private convertToDetectedTransactions(results: BatchAnalysisResult[]): DetectedTransaction[] {
    return results
      .filter((r) => r.isRealEstateRelated && r.propertyAddress)
      .map((r) => ({
        id: uuidv4(),
        propertyAddress: r.propertyAddress!,
        transactionType: r.transactionType || null,
        stage: null,
        confidence: r.confidence,
        extractionMethod: 'llm' as ExtractionMethod,
        communicationIds: [r.emailId],
        dateRange: { start: new Date().toISOString(), end: new Date().toISOString() },
        suggestedContacts: { assignments: [] },
        summary: r.reasoning || 'Detected via batch analysis',
      }));
  }
}

// Export singleton instance for convenience
export const hybridExtractorService = new HybridExtractorService();
export default hybridExtractorService;
