/**
 * Transaction Service
 * Orchestrates the entire transaction extraction workflow:
 * Fetches emails -> Analyzes -> Extracts data -> Saves to database
 *
 * Types are defined in ./types.ts
 * getEarliestCommunicationDate is in ./getEarliestCommunicationDate.ts
 */

import type {
  Transaction,
  NewTransaction,
  UpdateTransaction,
  Communication,
  NewCommunication,
  OAuthProvider,
  Contact,
  Message,
} from "../../types";

import gmailFetchService from "../gmailFetchService";
import outlookFetchService from "../outlookFetchService";
import transactionExtractorService from "../transactionExtractorService";
import databaseService from "../databaseService";
import logService from "../logService";
import { getContactNames } from "../contactsService";
import { FIRST_SCAN_LOOKBACK_MONTHS } from "../../constants";
import { createCommunicationReference } from "../messageMatchingService";
import { autoLinkCommunicationsForContact } from "../autoLinkService";
import emailSyncService from "../emailSyncService";
import { dbGet, dbAll } from "../db/core/dbConnection";
import { isTransactionFrozen } from "../transactionFreezePolicy";
import { UNFREEZE_OVERRIDE_KEY } from "../db/transactionDbService";
import auditService from "../auditService";
import { createEmail, getEmailByExternalId } from "../db/emailDbService";
import emailAttachmentService from "../emailAttachmentService";
import * as externalContactDb from "../db/externalContactDbService";
import { isContactSourceEnabled } from "../../utils/preferenceHelper";

// Hybrid extraction imports
import { HybridExtractorService } from "../extraction/hybridExtractorService";
import {
  ExtractionStrategyService,
  ExtractionStrategy,
} from "../extraction/extractionStrategyService";
import { LLMConfigService } from "../llm/llmConfigService";
import type {
  ExtractionMethod,
  DetectedTransaction,
  MessageInput,
} from "../extraction/types";
import type { AnalysisResult } from "../transactionExtractorService";

// Import types from companion file
import type {
  FetchProgress,
  ProgressUpdate,
  ScanOptions,
  ScanResult,
  TransactionWithSummary,
  EmailFetchOptions,
  AnalyzedEmail,
  EmailMessage,
  AddressComponents,
  AuditedTransactionData,
  ContactRoleUpdate,
  TransactionWithDetails,
  RawEmailAttachment,
  DateRange,
  ReanalysisResult,
  AssignContactResult,
} from "./types";

/**
 * Transaction Service
 * Orchestrates the entire transaction extraction workflow
 * Fetches emails -> Analyzes -> Extracts data -> Saves to database
 */
class TransactionService {
  private scanCancelled: boolean = false;
  private currentScanUserId: string | null = null;

  // Lazy-initialized hybrid extraction services
  private hybridExtractor: HybridExtractorService | null = null;
  private strategyService: ExtractionStrategyService | null = null;
  private llmConfigService: LLMConfigService | null = null;

  constructor() {}

  /**
   * Lazy initialization of hybrid extraction services.
   * Avoids startup cost when LLM features are not used.
   */
  private getHybridServices(): {
    extractor: HybridExtractorService;
    strategy: ExtractionStrategyService;
    config: LLMConfigService;
  } {
    if (!this.llmConfigService) {
      this.llmConfigService = new LLMConfigService();
    }
    if (!this.strategyService) {
      this.strategyService = new ExtractionStrategyService(this.llmConfigService);
    }
    if (!this.hybridExtractor) {
      this.hybridExtractor = new HybridExtractorService(this.llmConfigService);
    }
    return {
      extractor: this.hybridExtractor,
      strategy: this.strategyService,
      config: this.llmConfigService,
    };
  }

  /**
   * Cancel the current scan for a user
   */
  cancelScan(userId: string): boolean {
    if (this.currentScanUserId === userId) {
      this.scanCancelled = true;
      logService.info("Scan cancelled", "TransactionService.cancelScan", {
        userId,
      });
      return true;
    }
    return false;
  }

  /**
   * Check if scan was cancelled and throw if so
   */
  private checkCancelled(): void {
    if (this.scanCancelled) {
      throw new Error("Scan cancelled by user");
    }
  }

  // ============================================
  // SCAN & EXTRACTION METHODS
  // ============================================

  /**
   * Scan user's emails and extract transactions
   */
  async scanAndExtractTransactions(
    userId: string,
    options: ScanOptions = {},
  ): Promise<ScanResult> {
    // Reset cancellation state and track current scan
    this.scanCancelled = false;
    this.currentScanUserId = userId;

    // TASK-2072: Smart scan window — no fixed lookbackMonths.
    // Each provider uses last_sync_at (incremental) or 1-month fallback (first scan).
    // The per-provider logic is in the provider loop below.

    // TASK-1951: Fetch inferred contact source preferences
    let inferOutlookContacts = false;
    let inferGmailContacts = false;
    let inferMessageContacts = false;
    try {
      [inferOutlookContacts, inferGmailContacts, inferMessageContacts] = await Promise.all([
        isContactSourceEnabled(userId, "inferred", "outlookEmails", false),
        isContactSourceEnabled(userId, "inferred", "gmailEmails", false),
        isContactSourceEnabled(userId, "inferred", "messages", false),
      ]);

      await logService.info(
        "Inferred contact source preferences loaded",
        "TransactionService.scanAndExtractTransactions",
        {
          userId,
          inferOutlookContacts,
          inferGmailContacts,
          inferMessageContacts,
        },
      );
    } catch {
      // Use defaults (all OFF) if preferences unavailable
    }

    // TASK-2072: Default start date is 1 month ago (first-scan fallback).
    // Incremental scans override this per-provider using last_sync_at.
    const defaultStartDate = new Date();
    defaultStartDate.setMonth(defaultStartDate.getMonth() - FIRST_SCAN_LOOKBACK_MONTHS);

    const {
      provider: requestedProvider,
      startDate = defaultStartDate,
      endDate = new Date(),
      searchQuery = "",
      maxEmails = 70000,
      onProgress = null,
    } = options;

    // Auto-detect providers if not specified
    const providers: OAuthProvider[] = [];
    if (requestedProvider) {
      providers.push(requestedProvider);
    } else {
      const googleToken = await databaseService.getOAuthToken(
        userId,
        "google",
        "mailbox",
      );
      const microsoftToken = await databaseService.getOAuthToken(
        userId,
        "microsoft",
        "mailbox",
      );

      if (googleToken?.access_token) {
        providers.push("google");
      }
      if (microsoftToken?.access_token) {
        providers.push("microsoft");
      }

      await logService.info(
        "Auto-detected email providers",
        "TransactionService.scanAndExtractTransactions",
        {
          userId,
          providers,
          googleConnected: !!googleToken?.access_token,
          microsoftConnected: !!microsoftToken?.access_token,
        },
      );

      if (providers.length === 0) {
        throw new Error(
          "No email provider connected. Please connect Gmail or Outlook first.",
        );
      }
    }

    try {
      // Step 1: Fetch emails from all connected providers
      const allEmails: EmailMessage[] = [];
      const successfulProviders: OAuthProvider[] = [];

      for (let i = 0; i < providers.length; i++) {
        this.checkCancelled();

        const provider = providers[i];
        const providerName = provider === "google" ? "Gmail" : "Outlook";
        const providerPrefix =
          providers.length > 1
            ? `[${i + 1}/${providers.length}] ${providerName}: `
            : "";

        let effectiveStartDate: Date;
        const lastSyncAt = await databaseService.getOAuthTokenSyncTime(userId, provider);
        if (lastSyncAt) {
          effectiveStartDate = lastSyncAt;
          await logService.info(
            `Incremental sync: fetching emails since ${lastSyncAt.toISOString()}`,
            "TransactionService.scanAndExtractTransactions",
            { userId, provider, lastSyncAt: lastSyncAt.toISOString() },
          );
        } else {
          // TASK-2072: First-time sync uses FIRST_SCAN_LOOKBACK_MONTHS (1 month)
          const lookbackDate = new Date();
          lookbackDate.setMonth(
            lookbackDate.getMonth() - FIRST_SCAN_LOOKBACK_MONTHS,
          );
          effectiveStartDate =
            startDate > lookbackDate ? startDate : lookbackDate;
          await logService.info(
            `First scan: fetching last ${FIRST_SCAN_LOOKBACK_MONTHS} month(s) of emails`,
            "TransactionService.scanAndExtractTransactions",
            {
              userId,
              provider,
              lookbackMonths: FIRST_SCAN_LOOKBACK_MONTHS,
              startDate: effectiveStartDate.toISOString(),
            },
          );
        }

        if (onProgress)
          onProgress({
            step: "fetching",
            message: `${providerPrefix}Fetching emails...`,
          });

        const emails = await this._fetchEmails(userId, provider, {
          query: searchQuery,
          after: effectiveStartDate,
          before: endDate,
          maxResults: Math.floor(maxEmails / providers.length),
          onProgress: onProgress
            ? (fetchProgress: FetchProgress) => {
                if (this.scanCancelled) {
                  throw new Error("Scan cancelled by user");
                }
                const message = fetchProgress.hasEstimate
                  ? `${providerPrefix}Fetching emails... ${fetchProgress.fetched} of ${fetchProgress.total} (${fetchProgress.percentage}%)`
                  : `${providerPrefix}Fetching emails... ${fetchProgress.fetched} found`;
                onProgress({
                  step: "fetching",
                  message,
                  fetchProgress,
                });
              }
            : undefined,
        });

        this.checkCancelled();

        allEmails.push(...emails);
        successfulProviders.push(provider);
        await logService.info(
          `Fetched ${emails.length} emails from ${providerName}`,
          "TransactionService.scanAndExtractTransactions",
          { emailCount: emails.length, userId, provider },
        );
      }

      const emails = allEmails;
      await logService.info(
        `Fetched ${emails.length} total emails from ${providers.length} provider(s)`,
        "TransactionService.scanAndExtractTransactions",
        { emailCount: emails.length, userId, providers },
      );

      this.checkCancelled();

      // Step 2: Determine extraction strategy
      const { strategy: strategyService } = this.getHybridServices();
      const strategy = await strategyService.selectStrategy(userId, {
        messageCount: emails.length,
      });

      await logService.info(
        `Using ${strategy.method} extraction strategy: ${strategy.reason}`,
        "TransactionService.scanAndExtractTransactions",
        {
          userId,
          method: strategy.method,
          provider: strategy.provider,
          budgetRemaining: strategy.budgetRemaining,
          estimatedTokenCost: strategy.estimatedTokenCost,
        },
      );

      // Step 3: Run extraction based on strategy
      let extractionResult: {
        detectedTransactions: (DetectedTransaction & { emails?: AnalyzedEmail[] })[];
        realEstateCount: number;
        extractionMethod: ExtractionMethod;
      };

      if (strategy.method === "pattern") {
        extractionResult = await this._patternOnlyExtraction(
          emails,
          userId,
          onProgress,
        );
      } else {
        try {
          extractionResult = await this._hybridExtraction(
            emails,
            userId,
            strategy,
            onProgress,
          );
        } catch (hybridError) {
          await logService.warn(
            "Hybrid extraction failed, falling back to pattern-only",
            "TransactionService.scanAndExtractTransactions",
            {
              error: hybridError instanceof Error ? hybridError.message : String(hybridError),
              userId,
            },
          );
          extractionResult = await this._patternOnlyExtraction(
            emails,
            userId,
            onProgress,
          );
        }
      }

      await logService.info(
        `Found ${extractionResult.realEstateCount} real estate related emails`,
        "TransactionService.scanAndExtractTransactions",
        {
          realEstateCount: extractionResult.realEstateCount,
          totalEmails: emails.length,
          extractionMethod: extractionResult.extractionMethod,
        },
      );

      this.checkCancelled();

      // TASK-1951: Gate inferred contact extraction based on preferences
      const anyEmailInferenceEnabled = providers.some((p) => {
        if (p === "google") return inferGmailContacts;
        if (p === "microsoft") return inferOutlookContacts;
        return false;
      });

      if (!anyEmailInferenceEnabled) {
        let contactsCleared = 0;
        for (const tx of extractionResult.detectedTransactions) {
          if (tx.suggestedContacts?.assignments?.length > 0) {
            contactsCleared += tx.suggestedContacts.assignments.length;
            tx.suggestedContacts = { assignments: [] };
          }
        }
        if (contactsCleared > 0) {
          await logService.info(
            `Cleared ${contactsCleared} inferred contacts (email inference disabled for scanned providers)`,
            "TransactionService.scanAndExtractTransactions",
            { userId, providers, inferOutlookContacts, inferGmailContacts },
          );
        }
      }

      // Step 4: Save transactions with detection metadata
      if (onProgress)
        onProgress({ step: "saving", message: "Saving transactions..." });

      const transactions = await this._saveDetectedTransactions(
        userId,
        extractionResult,
        emails,
      );

      await logService.info(
        `Found ${transactions.length} properties`,
        "TransactionService.scanAndExtractTransactions",
        {
          propertyCount: transactions.length,
          extractionMethod: extractionResult.extractionMethod,
        },
      );

      // Step 5: Update last_sync_at for successful providers
      const syncTime = new Date();
      for (const provider of successfulProviders) {
        await databaseService.updateOAuthTokenSyncTime(userId, provider, syncTime);
        await logService.info(
          `Updated last_sync_at for ${provider}`,
          "TransactionService.scanAndExtractTransactions",
          { userId, provider, syncTime: syncTime.toISOString() },
        );
      }

      // Step 6: Complete
      if (onProgress)
        onProgress({ step: "complete", message: "Scan complete!" });

      return {
        success: true,
        transactionsFound: transactions.length,
        emailsScanned: emails.length,
        realEstateEmailsFound: extractionResult.realEstateCount,
        transactions,
      };
    } catch (error) {
      const isCancelled = this.scanCancelled;

      if (!isCancelled) {
        await logService.error(
          "Transaction scan failed",
          "TransactionService.scanAndExtractTransactions",
          {
            error: error instanceof Error ? error.message : String(error),
            userId,
            providers,
          },
        );
      }
      throw error;
    } finally {
      this.currentScanUserId = null;
    }
  }

  /**
   * Fetch emails from provider
   */
  private async _fetchEmails(
    userId: string,
    provider: OAuthProvider | undefined,
    options: EmailFetchOptions,
  ): Promise<EmailMessage[]> {
    if (provider === "google") {
      await gmailFetchService.initialize(userId);
      return await gmailFetchService.searchEmails(options);
    } else if (provider === "microsoft") {
      await outlookFetchService.initialize(userId);
      return await outlookFetchService.searchEmails(options);
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * Create transaction from extracted summary
   */
  private async _createTransactionFromSummary(
    userId: string,
    summary: { propertyAddress: string; transactionType?: "purchase" | "sale"; closingDate?: Date | string; communicationsCount: number; confidence?: number; firstCommunication: Date | string; lastCommunication: Date | string; salePrice?: number },
  ): Promise<string> {
    const addressParts = this._parseAddress(summary.propertyAddress);

    const toISOString = (date: string | Date | number | null | undefined): string | undefined => {
      if (!date) return undefined;
      if (date instanceof Date) return date.toISOString();
      if (typeof date === "string") return date;
      if (typeof date === "number") return new Date(date).toISOString();
      return undefined;
    };

    const transactionData: Partial<NewTransaction> = {
      user_id: userId,
      property_address: summary.propertyAddress,
      property_street: addressParts.street || undefined,
      property_city: addressParts.city || undefined,
      property_state: addressParts.state || undefined,
      property_zip: addressParts.zip || undefined,
      transaction_type: summary.transactionType,
      status: "active",
      closed_at: toISOString(summary.closingDate),
      closing_date_verified: false,
      communications_scanned: summary.communicationsCount || 0,
      extraction_confidence: summary.confidence,
      first_communication_date: toISOString(summary.firstCommunication),
      last_communication_date: toISOString(summary.lastCommunication),
      total_communications_count: summary.communicationsCount || 0,
      sale_price:
        typeof summary.salePrice === "number" ? summary.salePrice : undefined,
      export_status: "not_exported",
      export_count: 0,
      offer_count: 0,
      failed_offers_count: 0,
    };

    const transaction = await databaseService.createTransaction(
      transactionData as NewTransaction,
    );
    return transaction.id;
  }

  /**
   * Save communications to database and link to transaction
   */
  private async _saveCommunications(
    userId: string,
    transactionId: string,
    analyzedEmails: AnalyzedEmail[],
    originalEmails: EmailMessage[],
  ): Promise<void> {
    for (const analyzed of analyzedEmails) {
      const originalEmail = originalEmails.find(
        (e) => e.subject === analyzed.subject && e.from === analyzed.from,
      );

      if (!originalEmail) continue;

      const sentAt =
        analyzed.date instanceof Date
          ? analyzed.date.toISOString()
          : typeof analyzed.date === "string"
            ? analyzed.date
            : new Date().toISOString();

      const isIgnored = await databaseService.isEmailIgnoredByUser(
        userId,
        analyzed.from || "",
        analyzed.subject || "",
        sentAt,
      );

      if (isIgnored) {
        await logService.debug(
          "Skipping previously ignored email",
          "TransactionService._saveCommunications",
          {
            subject: analyzed.subject,
            from: analyzed.from,
            sentAt,
          },
        );
        continue;
      }

      const externalId = originalEmail.id ||
        originalEmail.messageIdHeader ||
        `${analyzed.from}_${analyzed.subject}_${sentAt}`;

      if (!originalEmail.id && !originalEmail.messageIdHeader) {
        await logService.warn(
          "Using composite fallback for external_id - originalEmail missing id fields",
          "TransactionService._saveCommunications",
          { subject: analyzed.subject, from: analyzed.from },
        );
      }

      let emailRecord = await getEmailByExternalId(userId, externalId);

      if (!emailRecord) {
        emailRecord = await createEmail({
          user_id: userId,
          external_id: externalId,
          source: analyzed.from.includes("@gmail") ? "gmail" : "outlook",
          thread_id: originalEmail.threadId,
          sender: analyzed.from,
          recipients: originalEmail.to || undefined,
          cc: originalEmail.cc || undefined,
          bcc: originalEmail.bcc || undefined,
          subject: analyzed.subject,
          body_html: originalEmail.body,
          body_plain: originalEmail.bodyPlain,
          sent_at: sentAt,
          received_at: sentAt,
          has_attachments: originalEmail.hasAttachments || false,
          attachment_count: originalEmail.attachmentCount || 0,
          message_id_header: originalEmail.messageIdHeader || undefined,
        });
      }

      if (
        originalEmail.hasAttachments &&
        originalEmail.id &&
        originalEmail.attachments &&
        originalEmail.attachments.length > 0
      ) {
        const source: "gmail" | "outlook" = analyzed.from?.includes("@gmail")
          ? "gmail"
          : "outlook";

        try {
          await emailAttachmentService.downloadEmailAttachments(
            userId,
            emailRecord.id,
            originalEmail.id,
            source,
            originalEmail.attachments.map((att: RawEmailAttachment) => ({
              filename: att.filename || att.name || "attachment",
              mimeType: att.mimeType || att.contentType || "application/octet-stream",
              size: att.size || 0,
              attachmentId: att.attachmentId || att.id || "",
            }))
          );
        } catch (error) {
          await logService.warn(
            "Failed to download email attachments",
            "TransactionService._saveCommunications",
            {
              emailId: emailRecord.id,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );
        }
      }

      // BACKLOG-1718 (R3): include thread_id so unlinkCommunication can expand
      // the deletion to all sibling emails sharing the same thread.
      const commData: Partial<NewCommunication> = {
        user_id: userId,
        transaction_id: transactionId,
        email_id: emailRecord.id,
        thread_id: emailRecord.thread_id || undefined,
        communication_type: "email",
        attachment_metadata: originalEmail.attachments
          ? JSON.stringify(originalEmail.attachments)
          : undefined,
        keywords_detected: Array.isArray(analyzed.keywords)
          ? JSON.stringify(analyzed.keywords)
          : analyzed.keywords,
        parties_involved: Array.isArray(analyzed.parties)
          ? JSON.stringify(analyzed.parties)
          : analyzed.parties,
        relevance_score: analyzed.confidence,
        flagged_for_review: false,
        is_compliance_related: analyzed.isRealEstateRelated || false,
      };

      await databaseService.createCommunication(commData as NewCommunication);
    }
  }

  /**
   * Parse address string into components
   */
  private _parseAddress(addressString: string): AddressComponents {
    const parts = addressString.split(",").map((p) => p.trim());

    return {
      street: parts[0] || null,
      city: parts[1] || null,
      state: parts[2] ? parts[2].split(" ")[0] : null,
      zip: parts[2] ? parts[2].split(" ")[1] : null,
    };
  }

  // ============================================
  // HYBRID EXTRACTION METHODS
  // ============================================

  /**
   * Hybrid extraction path using AI + pattern matching.
   */
  private async _hybridExtraction(
    emails: EmailMessage[],
    userId: string,
    strategy: ExtractionStrategy,
    onProgress: ((progress: ProgressUpdate) => void) | null,
  ): Promise<{
    detectedTransactions: DetectedTransaction[];
    realEstateCount: number;
    extractionMethod: ExtractionMethod;
  }> {
    const { extractor } = this.getHybridServices();

    if (onProgress) {
      onProgress({
        step: "analyzing",
        message: `Analyzing ${emails.length} emails with AI...`,
      });
    }

    const messages: MessageInput[] = emails.map((email, i) => ({
      id: `msg_${i}_${Date.now()}`,
      subject: email.subject || "",
      body: email.bodyPlain || email.body || "",
      sender: email.from || "",
      recipients: (email.to || "").split(",").map((e: string) => e.trim()),
      date:
        email.date instanceof Date
          ? email.date.toISOString()
          : String(email.date || new Date().toISOString()),
    }));

    const existingTransactions = await databaseService.getTransactions({
      user_id: userId,
    });
    const txContext = existingTransactions.map((tx) => ({
      id: tx.id,
      propertyAddress: tx.property_address,
      transactionType: tx.transaction_type,
    }));

    const contacts: Contact[] = await databaseService.getContacts({
      user_id: userId,
    });

    this.checkCancelled();

    const result = await extractor.extract(messages, txContext, contacts, {
      usePatternMatching: true,
      useLLM: strategy.method !== "pattern",
      llmProvider: strategy.provider,
      userId,
    });

    this.checkCancelled();

    if (onProgress) {
      onProgress({
        step: "grouping",
        message: `Found ${result.detectedTransactions.length} potential transactions...`,
      });
    }

    const realEstateCount = result.analyzedMessages.filter(
      (m) => m.isRealEstateRelated,
    ).length;

    await logService.info(
      `Hybrid extraction completed`,
      "TransactionService._hybridExtraction",
      {
        userId,
        method: result.extractionMethod,
        llmUsed: result.llmUsed,
        transactionsFound: result.detectedTransactions.length,
        realEstateCount,
        latencyMs: result.latencyMs,
      },
    );

    return {
      detectedTransactions: result.detectedTransactions,
      realEstateCount,
      extractionMethod: result.extractionMethod,
    };
  }

  /**
   * Pattern-only extraction (existing behavior refactored).
   */
  private async _patternOnlyExtraction(
    emails: EmailMessage[],
    _userId: string,
    onProgress: ((progress: ProgressUpdate) => void) | null,
  ): Promise<{
    detectedTransactions: (DetectedTransaction & { emails?: AnalyzedEmail[] })[];
    realEstateCount: number;
    extractionMethod: ExtractionMethod;
  }> {
    if (onProgress) {
      onProgress({
        step: "analyzing",
        message: `Analyzing ${emails.length} emails...`,
      });
    }

    const emailsWithDate = emails.map((email) => ({
      subject: email.subject || undefined,
      from: email.from || undefined,
      to: email.to || undefined,
      body: email.body,
      bodyPlain: email.bodyPlain,
      snippet: email.snippet,
      bodyPreview: email.bodyPreview,
      date: email.date || new Date().toISOString(),
    }));

    const analyzed = transactionExtractorService.batchAnalyze(emailsWithDate);
    const realEstateResults = analyzed.filter((a) => a.isRealEstateRelated);

    this.checkCancelled();

    if (onProgress) {
      onProgress({ step: "grouping", message: "Grouping by property..." });
    }

    const grouped = transactionExtractorService.groupByProperty(realEstateResults);

    const detectedTransactions: (DetectedTransaction & { emails?: AnalyzedEmail[] })[] = Object.entries(grouped)
      .map(([address, emailGroup]) => {
        const summary =
          transactionExtractorService.generateTransactionSummary(emailGroup);
        if (!summary) return null;

        const analyzedEmails: AnalyzedEmail[] = emailGroup.map((result) => {
          let keywordsStr: string | undefined;
          if (Array.isArray(result.keywords)) {
            keywordsStr = result.keywords.map((k) => k.keyword).join(", ");
          } else if (typeof result.keywords === "string") {
            keywordsStr = result.keywords;
          }

          let partiesStr: string | undefined;
          if (Array.isArray(result.parties)) {
            partiesStr = result.parties.map((p) => p.name || p.email).join(", ");
          } else if (typeof result.parties === "string") {
            partiesStr = result.parties;
          }

          return {
            subject: result.subject,
            from: result.from || "",
            date: result.date,
            isRealEstateRelated: result.isRealEstateRelated,
            keywords: keywordsStr,
            parties: partiesStr,
            confidence: result.confidence,
          };
        });

        return {
          id: `pat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          propertyAddress: address,
          transactionType: summary.transactionType || null,
          stage: null,
          confidence: (summary.confidence || 0) / 100,
          extractionMethod: "pattern" as ExtractionMethod,
          communicationIds: [],
          dateRange: {
            start: new Date(summary.firstCommunication).toISOString(),
            end: new Date(summary.lastCommunication).toISOString(),
          },
          suggestedContacts: { assignments: [] },
          summary: `Transaction at ${address}`,
          patternSummary: {
            propertyAddress: summary.propertyAddress,
            transactionType: summary.transactionType,
            salePrice: summary.salePrice,
            closingDate: summary.closingDate
              ? typeof summary.closingDate === "string"
                ? summary.closingDate
                : new Date(summary.closingDate).toISOString()
              : null,
            mlsNumbers: summary.mlsNumbers || [],
            communicationsCount: summary.communicationsCount,
            firstCommunication: summary.firstCommunication,
            lastCommunication: summary.lastCommunication,
            confidence: summary.confidence || 0,
          },
          emails: analyzedEmails,
        } as DetectedTransaction & { emails: AnalyzedEmail[] };
      })
      .filter((tx): tx is DetectedTransaction & { emails: AnalyzedEmail[] } => tx !== null);

    return {
      detectedTransactions,
      realEstateCount: realEstateResults.length,
      extractionMethod: "pattern",
    };
  }

  /**
   * Save detected transactions with detection metadata.
   */
  private async _saveDetectedTransactions(
    userId: string,
    extractionResult: {
      detectedTransactions: (DetectedTransaction & { emails?: AnalyzedEmail[] })[];
      realEstateCount: number;
      extractionMethod: ExtractionMethod;
    },
    originalEmails: EmailMessage[],
  ): Promise<TransactionWithSummary[]> {
    const transactions: TransactionWithSummary[] = [];

    const propertyAddresses = extractionResult.detectedTransactions.map(
      (tx) => tx.propertyAddress
    );
    const existingTransactions = await databaseService.findExistingTransactionsByAddresses(
      userId,
      propertyAddresses,
    );

    let skippedCount = 0;

    for (const detected of extractionResult.detectedTransactions) {
      this.checkCancelled();

      const normalizedAddress = detected.propertyAddress.toLowerCase().trim();
      const existingTxId = existingTransactions.get(normalizedAddress);
      if (existingTxId) {
        skippedCount++;
        await logService.debug(
          "Skipping duplicate transaction import",
          "TransactionService._saveDetectedTransactions",
          {
            propertyAddress: detected.propertyAddress,
            existingTransactionId: existingTxId,
            userId,
          },
        );
        continue;
      }

      const addressParts = this._parseAddress(detected.propertyAddress);

      const toISOString = (date: string | Date | number | undefined | null): string | undefined => {
        if (!date) return undefined;
        if (date instanceof Date) return date.toISOString();
        if (typeof date === "string") return date;
        if (typeof date === "number") return new Date(date).toISOString();
        return undefined;
      };

      const detectionSource: "manual" | "auto" | "hybrid" =
        extractionResult.extractionMethod === "hybrid" ? "hybrid" : "auto";

      let txType: "purchase" | "sale" | "other" | undefined;
      if (detected.transactionType === "purchase" || detected.transactionType === "sale") {
        txType = detected.transactionType;
      } else if (detected.transactionType === "lease") {
        txType = "other";
      } else {
        txType = undefined;
      }

      const transactionData: Partial<NewTransaction> = {
        user_id: userId,
        property_address: detected.propertyAddress,
        property_street: addressParts.street || undefined,
        property_city: addressParts.city || undefined,
        property_state: addressParts.state || undefined,
        property_zip: addressParts.zip || undefined,
        transaction_type: txType,
        status: "active",
        closed_at: toISOString(detected.dateRange?.end),
        closing_date_verified: false,
        extraction_confidence: Math.round(detected.confidence * 100),
        first_communication_date: toISOString(detected.dateRange?.start),
        last_communication_date: toISOString(detected.dateRange?.end),
        total_communications_count: detected.communicationIds?.length || 0,
        export_status: "not_exported",
        export_count: 0,
        offer_count: 0,
        failed_offers_count: 0,
        detection_source: detectionSource,
        detection_status: "pending",
        detection_confidence: detected.confidence,
        detection_method: extractionResult.extractionMethod,
        suggested_contacts: detected.suggestedContacts
          ? JSON.stringify(detected.suggestedContacts)
          : undefined,
      };

      const transaction = await databaseService.createTransaction(
        transactionData as NewTransaction,
      );

      const emailsToSave = detected.emails || [];
      if (emailsToSave.length > 0) {
        await this._saveCommunications(
          userId,
          transaction.id,
          emailsToSave,
          originalEmails,
        );
      }

      const { id: _detectedId, ...detectedWithoutId } = detected;
      transactions.push({
        id: transaction.id,
        ...detectedWithoutId,
      } as TransactionWithSummary);
    }

    if (skippedCount > 0 || transactions.length > 0) {
      await logService.info(
        "Transaction import completed",
        "TransactionService._saveDetectedTransactions",
        {
          userId,
          totalDetected: extractionResult.detectedTransactions.length,
          created: transactions.length,
          skippedDuplicates: skippedCount,
        },
      );
    }

    return transactions;
  }

  // ============================================
  // CRUD METHODS
  // ============================================

  /**
   * Get all transactions for a user
   */
  async getTransactions(userId: string): Promise<Transaction[]> {
    return await databaseService.getTransactions({ user_id: userId });
  }

  /**
   * Get transaction by ID with communications and contact assignments
   */
  async getTransactionDetails(
    transactionId: string,
    channelFilter?: "email" | "text",
    limit?: number,
  ): Promise<TransactionWithDetails | null> {
    const transaction = await databaseService.getTransactionById(transactionId);

    if (!transaction) {
      return null;
    }

    const communications =
      await databaseService.getCommunicationsByTransaction(transactionId, channelFilter, limit);
    const contact_assignments =
      await databaseService.getTransactionContactsWithRoles(transactionId);

    return {
      ...transaction,
      communications,
      contact_assignments,
    };
  }

  /**
   * PERF: Lightweight version of getTransactionDetails for overview tab.
   */
  async getTransactionOverview(
    transactionId: string,
  ): Promise<TransactionWithDetails | null> {
    const transaction = await databaseService.getTransactionById(transactionId);

    if (!transaction) {
      return null;
    }

    const contact_assignments =
      await databaseService.getTransactionContactsWithRoles(transactionId);

    return {
      ...transaction,
      communications: [],
      contact_assignments,
    };
  }

  /**
   * Create manual transaction (user-entered)
   */
  async createManualTransaction(
    userId: string,
    transactionData: Partial<NewTransaction>,
  ): Promise<Transaction> {
    const transaction = await databaseService.createTransaction({
      user_id: userId,
      property_address: transactionData.property_address!,
      property_street: transactionData.property_street,
      property_city: transactionData.property_city,
      property_state: transactionData.property_state,
      property_zip: transactionData.property_zip,
      transaction_type: transactionData.transaction_type,
      status: transactionData.status || "active",
      started_at: transactionData.started_at,
      closed_at: transactionData.closed_at,
      closing_date_verified: false,
      representation_start_confidence: undefined,
      closing_date_confidence: undefined,
      export_status: "not_exported",
      export_count: 0,
      communications_scanned: 0,
      total_communications_count: 0,
      offer_count: 0,
      failed_offers_count: 0,
    } as NewTransaction);

    return transaction;
  }

  /**
   * Create audited transaction with contact assignments
   */
  async createAuditedTransaction(
    userId: string,
    data: AuditedTransactionData,
  ): Promise<Transaction | null> {
    try {
      const {
        property_address,
        property_street,
        property_city,
        property_state,
        property_zip,
        property_coordinates,
        transaction_type,
        contact_assignments,
        started_at,
        closed_at,
        closing_deadline,
      } = data;

      const transaction = await databaseService.createTransaction({
        user_id: userId,
        property_address,
        property_street,
        property_city,
        property_state,
        property_zip,
        property_coordinates,
        transaction_type,
        status: "active",
        started_at,
        closed_at,
        closing_deadline,
        closing_date_verified: property_coordinates ? true : false,
        export_status: "not_exported",
        export_count: 0,
        communications_scanned: 0,
        total_communications_count: 0,
        offer_count: 0,
        failed_offers_count: 0,
      } as NewTransaction);
      const transactionId = transaction.id;

      if (contact_assignments && contact_assignments.length > 0) {
        for (const assignment of contact_assignments) {
          await databaseService.assignContactToTransaction(transactionId, {
            contact_id: assignment.contact_id,
            role: assignment.role,
            role_category: assignment.role_category,
            specific_role: assignment.role,
            is_primary: assignment.is_primary,
            notes: assignment.notes,
          });
        }

        let totalEmailsLinked = 0;
        let totalMessagesLinked = 0;

        for (const assignment of contact_assignments) {
          try {
            const autoLinkResult = await autoLinkCommunicationsForContact({
              contactId: assignment.contact_id,
              transactionId,
            });
            totalEmailsLinked += autoLinkResult.emailsLinked;
            totalMessagesLinked += autoLinkResult.messagesLinked;
          } catch (error) {
            await logService.warn(
              `Auto-link failed for contact ${assignment.contact_id}: ${error instanceof Error ? error.message : "Unknown"}`,
              "TransactionService.createAuditedTransaction",
            );
          }
        }

        if (totalEmailsLinked > 0 || totalMessagesLinked > 0) {
          await logService.info(
            `Auto-linked ${totalEmailsLinked} emails and ${totalMessagesLinked} messages for new transaction`,
            "TransactionService.createAuditedTransaction",
            { transactionId, contactCount: contact_assignments.length },
          );
        }
      }

      return await this.getTransactionWithContacts(transactionId);
    } catch (error) {
      await logService.error(
        "Failed to create audited transaction",
        "TransactionService.createAuditedTransaction",
        {
          error: error instanceof Error ? error.message : String(error),
          userId,
          propertyAddress: data.property_address,
        },
      );
      throw error;
    }
  }

  /**
   * Get transaction with all assigned contacts
   */
  async getTransactionWithContacts(
    transactionId: string,
  ): Promise<TransactionWithDetails | null> {
    const transaction = await databaseService.getTransactionById(transactionId);

    if (!transaction) {
      return null;
    }

    const contactAssignments =
      await databaseService.getTransactionContactsWithRoles(transactionId);

    return {
      ...transaction,
      contact_assignments: contactAssignments,
    };
  }

  /**
   * Assign contact to transaction role
   *
   * TASK-2067: Now fetches from provider before auto-linking so that emails
   * from the audit period are stored locally before the auto-link search runs.
   */
  async assignContactToTransaction(
    transactionId: string,
    contactId: string,
    role: string,
    roleCategory: string,
    isPrimary: boolean = false,
    notes: string | null = null,
    skipAutoLink: boolean = false,
  ): Promise<AssignContactResult> {
    await databaseService.assignContactToTransaction(transactionId, {
      contact_id: contactId,
      role: role,
      role_category: roleCategory,
      specific_role: role,
      is_primary: isPrimary ? 1 : 0,
      notes: notes || undefined,
    });

    if (skipAutoLink) {
      return { success: true };
    }

    try {
      // TASK-2067: Fetch from provider for audit period, store locally, then auto-link.
      // This ensures provider emails are in the local DB before auto-link searches it.
      const transaction = await databaseService.getTransactionById(transactionId);
      if (transaction) {
        const fetchResult = await emailSyncService.fetchAndAutoLinkForContact({
          userId: transaction.user_id,
          transactionId,
          contactId,
          transactionDetails: {
            started_at: transaction.started_at,
            created_at: transaction.created_at,
            closed_at: transaction.closed_at,
          },
        });

        return {
          success: true,
          autoLink: fetchResult.autoLinkResult,
        };
      }

      // Fallback: if transaction not found, still try local-only auto-link
      const autoLinkResult = await autoLinkCommunicationsForContact({
        contactId,
        transactionId,
      });

      return {
        success: true,
        autoLink: autoLinkResult,
      };
    } catch (error) {
      await logService.warn(
        `Auto-link failed after contact assignment: ${error instanceof Error ? error.message : "Unknown"}`,
        "TransactionService.assignContactToTransaction",
        { transactionId, contactId },
      );

      return { success: true };
    }
  }

  /**
   * Remove contact from transaction
   *
   * BACKLOG-2150 — party removal is allowed even after first export. The only
   * frozen anchors are the property address block, transaction type, and the
   * audit-window start date (enforced at the db layer). Removing a party from a
   * frozen (property, type, start) transaction cannot enable deal reuse, so the
   * earlier add-only guard was dropped.
   */
  async removeContactFromTransaction(
    transactionId: string,
    contactId: string,
  ): Promise<void> {
    return await databaseService.unlinkContactFromTransaction(
      transactionId,
      contactId,
    );
  }

  /**
   * Batch update contact assignments for a transaction
   */
  async batchUpdateContactAssignments(
    transactionId: string,
    operations: Array<{
      action: "add" | "remove";
      contactId: string;
      role?: string;
      roleCategory?: string;
      specificRole?: string;
      isPrimary?: boolean;
      notes?: string;
    }>,
  ): Promise<void> {
    // BACKLOG-2150 — party add AND remove are allowed after first export; no
    // freeze guard here (identity anchors are enforced at the db layer).
    return await databaseService.batchUpdateContactAssignments(
      transactionId,
      operations,
    );
  }

  /**
   * Update contact role in transaction
   */
  async updateContactRole(
    transactionId: string,
    contactId: string,
    updates: ContactRoleUpdate,
  ): Promise<void> {
    return await databaseService.updateContactRole(transactionId, contactId, {
      ...updates,
      role: updates.role || undefined,
    });
  }

  /**
   * Update transaction
   */
  async updateTransaction(
    transactionId: string,
    updates: Partial<UpdateTransaction>,
  ): Promise<void> {
    return await databaseService.updateTransaction(transactionId, updates);
  }

  /**
   * BACKLOG-2013 — read the freeze marker for a transaction.
   * Returns true once the transaction has been exported at least once.
   */
  private isTransactionFrozenById(transactionId: string): boolean {
    const row = dbGet<{ first_exported_at: string | null }>(
      "SELECT first_exported_at FROM transactions WHERE id = ?",
      [transactionId],
    );
    return isTransactionFrozen(row ?? undefined);
  }

  /**
   * BACKLOG-2013 — ADMIN / SUPPORT UNFREEZE.
   *
   * Clears `first_exported_at`, re-opening the transaction for a genuine
   * post-export typo correction. Intentionally MINIMAL: a guarded db write +
   * an audit row. A richer admin-portal surface is a follow-up (deferred).
   *
   * The unfreeze itself is audit-logged (compliance positioning); subsequent
   * edits are then captured by the existing TRANSACTION_UPDATE audit path.
   * Uses the db-layer override so this write is not itself blocked by the guard.
   */
  async adminUnfreezeTransaction(
    transactionId: string,
    reason: string,
    actor?: string,
  ): Promise<{ success: boolean; wasFrozen: boolean }> {
    const wasFrozen = this.isTransactionFrozenById(transactionId);
    const transaction = await databaseService.getTransactionById(transactionId);
    const userId = transaction?.user_id ?? "unknown";

    // Clear the freeze marker via the override path (a normal update would be
    // blocked because first_exported_at is not an identity field but the guard
    // must never trip on the unfreeze write itself).
    await databaseService.updateTransaction(transactionId, {
      first_exported_at: null,
      export_status: "re_export_needed",
      [UNFREEZE_OVERRIDE_KEY]: true,
    } as unknown as Partial<UpdateTransaction>);

    await auditService.log({
      userId,
      action: "TRANSACTION_UPDATE",
      resourceType: "TRANSACTION",
      resourceId: transactionId,
      metadata: {
        event: "export_freeze_unfrozen",
        reason,
        actor: actor ?? "admin",
        wasFrozen,
      },
      success: true,
    });

    await logService.info(
      "Transaction unfrozen by admin (BACKLOG-2013)",
      "TransactionService.adminUnfreezeTransaction",
      { transactionId, wasFrozen, reason },
    );

    return { success: true, wasFrozen };
  }

  /**
   * Delete transaction
   */
  async deleteTransaction(transactionId: string): Promise<void> {
    await databaseService.deleteTransaction(transactionId);
  }

  /**
   * Unlink a communication (email) from a transaction.
   *
   * BACKLOG-1718: For email threads, expand the unlink to ALL sibling
   * communications that share the same thread_id within the same
   * transaction. The user-visible action is "remove this conversation
   * from the transaction" — removing only one reply in a 5-message thread
   * left the conversation broken with gaps. The expansion is atomic at
   * the per-row level (we iterate inside a try/catch so a single failure
   * does not silently leave a partial state).
   *
   * SMS messages do not use thread_id in the same conversational way, so
   * the expansion only triggers when (a) the communication is an email
   * AND (b) thread_id is set.
   */
  async unlinkCommunication(
    communicationId: string,
    reason?: string,
  ): Promise<{ unlinkedIds: string[] }> {
    const communication =
      await databaseService.getCommunicationById(communicationId);

    if (!communication) {
      throw new Error("Communication not found");
    }

    if (!communication.transaction_id) {
      throw new Error("Communication is not linked to a transaction");
    }

    // BACKLOG-2150 — linked communications are add-AND-remove after first
    // export. Detaching a comm from a frozen (property, type, start)
    // transaction cannot enable deal reuse (it only removes comms of the SAME
    // deal), so the earlier add-only detach guard was dropped. New synced comms
    // still auto-link and re-export stays open.

    // BACKLOG-1560: Extract email_id and thread_id from communications junction record.
    // getCommunicationById queries the communications table which has these columns.
    const commRecord = communication as Communication & {
      email_id?: string;
      thread_id?: string;
      message_id?: string;
      communication_type?: string;
    };

    // BACKLOG-1718: collect every communication-id in the same thread for
    // this transaction. The clicked row is always included (deduped via Set).
    const idsToUnlink = new Set<string>([communicationId]);

    // BACKLOG-1718 (R3): For pre-fix communications rows where thread_id was
    // not stored (autoLinkService bug), fall back to resolving thread_id via
    // the emails table when email_id is present but thread_id is missing.
    let resolvedThreadId = commRecord.thread_id;
    if (!resolvedThreadId && commRecord.email_id) {
      try {
        const emailRow = dbGet<{ thread_id: string | null }>(
          "SELECT thread_id FROM emails WHERE id = ?",
          [commRecord.email_id],
        );
        resolvedThreadId = emailRow?.thread_id || undefined;
      } catch (err) {
        await logService.warn(
          "Failed to resolve thread_id from emails table during unlinkCommunication",
          "TransactionService.unlinkCommunication",
          { communicationId, email_id: commRecord.email_id, err },
        );
      }
    }

    const isEmailThread =
      (commRecord.communication_type === "email" ||
        commRecord.email_id ||
        !commRecord.message_id) &&
      resolvedThreadId;

    if (isEmailThread) {
      try {
        // BACKLOG-1718 (R3): use resolvedThreadId (may be resolved from emails
        // table when commRecord.thread_id was NULL for pre-fix rows).
        //
        // BACKLOG-1718 (R5): NULL-immune sibling match — also capture rows
        // where thread_id IS NULL but email_id → emails.thread_id matches.
        // This covers communications rows created by restoreRemovedEmailThread
        // before R5, which wrote NULL thread_id and broke subsequent unlinks.
        const siblings = dbAll<{ id: string }>(
          `SELECT c.id FROM communications c
            WHERE c.transaction_id = ?
              AND (
                c.thread_id = ?
                OR (
                  c.thread_id IS NULL
                  AND c.email_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM emails e
                    WHERE e.id = c.email_id AND e.thread_id = ?
                  )
                )
              )
              AND (c.message_id IS NULL OR c.message_id = '')`,
          [communication.transaction_id, resolvedThreadId, resolvedThreadId],
        );
        for (const row of siblings) idsToUnlink.add(row.id);
      } catch (err) {
        await logService.warn(
          "Thread-sibling enumeration failed; falling back to single-row unlink",
          "TransactionService.unlinkCommunication",
          { communicationId, thread_id: resolvedThreadId, err },
        );
      }
    }

    let removed = 0;
    let failed = 0;
    // BACKLOG-1778: collect the communication ids actually removed so the
    // renderer can drop exactly those rows in place (no full-list refetch,
    // which reset the email list scroll position — the 1765 regression).
    const unlinkedIds: string[] = [];
    for (const id of idsToUnlink) {
      try {
        const sibling =
          id === communicationId
            ? communication
            : await databaseService.getCommunicationById(id);
        if (!sibling || !sibling.transaction_id) continue;
        const siblingRec = sibling as Communication & {
          email_id?: string;
          thread_id?: string;
        };

        // BACKLOG-1585: Resolve email_id when null (older records or
        // thread-based linking). Without email_id the ignored_communications
        // row won't appear in "Show removed emails".
        let resolvedEmailId = siblingRec.email_id || undefined;
        if (!resolvedEmailId && siblingRec.thread_id) {
          try {
            const emailByThread = dbGet<{ id: string }>(
              "SELECT id FROM emails WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1",
              [siblingRec.thread_id],
            );
            if (emailByThread) resolvedEmailId = emailByThread.id;
          } catch (err) {
            await logService.warn(
              "thread_id fallback failed during unlinkCommunication",
              "TransactionService.unlinkCommunication",
              { communicationId: id, thread_id: siblingRec.thread_id, err },
            );
          }
        }

        await databaseService.addIgnoredCommunication({
          user_id: sibling.user_id,
          transaction_id: sibling.transaction_id,
          email_subject: sibling.subject,
          email_sender: sibling.sender,
          email_sent_at: sibling.sent_at,
          email_id: resolvedEmailId,
          // BACKLOG-1560: Write thread_id for thread suppression during auto-link.
          thread_id: siblingRec.thread_id || undefined,
          original_communication_id: id,
          reason: reason || "Manually unlinked by user",
        });

        await databaseService.deleteCommunication(id);
        removed++;
        unlinkedIds.push(id);
      } catch (err) {
        failed++;
        await logService.warn(
          "Failed to unlink sibling communication in thread",
          "TransactionService.unlinkCommunication",
          { communicationId: id, err },
        );
      }
    }

    await logService.info(
      "Communication unlinked from transaction",
      "TransactionService.unlinkCommunication",
      {
        clickedCommunicationId: communicationId,
        transactionId: communication.transaction_id,
        threadId: resolvedThreadId || null,
        threadExpansion: isEmailThread,
        removedCount: removed,
        failedCount: failed,
        reason,
      },
    );

    // BACKLOG-1778: return the removed ids for in-place renderer updates.
    return { unlinkedIds };
  }

  /**
   * BACKLOG-1718 (R4): Thread-aware restore — symmetric with R3 unlink expansion.
   *
   * Finds every ignored_communications row for the same thread_id + transaction,
   * removes each suppression record, and re-links each email back to the transaction.
   * Falls back to single-email restore when thread_id is NULL/unresolvable.
   */
  async restoreRemovedEmailThread(
    ignoredCommId: string,
    emailId: string,
    transactionId: string,
    userId: string,
  ): Promise<{ restoredCount: number }> {
    // Resolve thread_id from the clicked ignored row.
    const clickedRow = dbGet<{ thread_id: string | null }>(
      "SELECT thread_id FROM ignored_communications WHERE id = ?",
      [ignoredCommId],
    );

    // NULL-fallback: mirrors R3 unlink pattern — check emails table when
    // communications.thread_id was NULL for pre-fix rows.
    let resolvedThreadId: string | null = clickedRow?.thread_id ?? null;
    if (!resolvedThreadId && emailId) {
      try {
        const emailRow = dbGet<{ thread_id: string | null }>(
          "SELECT thread_id FROM emails WHERE id = ?",
          [emailId],
        );
        resolvedThreadId = emailRow?.thread_id ?? null;
      } catch (err) {
        await logService.warn(
          "Failed to resolve thread_id from emails table during restoreRemovedEmailThread",
          "TransactionService.restoreRemovedEmailThread",
          { ignoredCommId, emailId, err },
        );
      }
    }

    // Gate: email thread only (email_id present + thread resolved). Excludes SMS.
    const isEmailThread = !!emailId && !!resolvedThreadId;

    // Always include the clicked row; expand to thread siblings when resolvable.
    const rowsToRestore = new Map<string, { id: string; email_id: string | null }>();
    rowsToRestore.set(ignoredCommId, { id: ignoredCommId, email_id: emailId });

    if (isEmailThread) {
      try {
        // BACKLOG-1718 (R5): NULL-immune sibling match — also capture
        // ignored_communications rows where thread_id IS NULL but
        // email_id → emails.thread_id matches. This handles rows written by
        // the pre-R5 unlink path operating on NULL-thread_id communications.
        const siblings = dbAll<{ id: string; email_id: string | null }>(
          `SELECT ic.id, ic.email_id FROM ignored_communications ic
            WHERE ic.transaction_id = ?
              AND (
                ic.thread_id = ?
                OR (
                  ic.thread_id IS NULL
                  AND ic.email_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM emails e
                    WHERE e.id = ic.email_id AND e.thread_id = ?
                  )
                )
              )
              AND ic.email_id IS NOT NULL`,
          [transactionId, resolvedThreadId, resolvedThreadId],
        );
        for (const row of siblings) rowsToRestore.set(row.id, row);
      } catch (err) {
        await logService.warn(
          "Thread-sibling enumeration failed; restoring single row only",
          "TransactionService.restoreRemovedEmailThread",
          { ignoredCommId, thread_id: resolvedThreadId, err },
        );
      }
    }

    let restoredCount = 0;
    for (const [, row] of rowsToRestore) {
      const rowEmailId = row.email_id || emailId;
      await databaseService.removeIgnoredCommunication(row.id);
      // BACKLOG-1718 (R5): include thread_id so the restored communications
      // row has a populated thread_id column. Omitting it was the root cause
      // of the remove→restore→remove cycle degradation: the next unlink's
      // sibling query (WHERE thread_id = ?) found NULL rows and expanded to
      // just one email instead of the full thread.
      await databaseService.createCommunication({
        user_id: userId,
        transaction_id: transactionId,
        email_id: rowEmailId,
        thread_id: resolvedThreadId || undefined,
        communication_type: "email",
        link_source: "manual",
        link_confidence: 1.0,
        has_attachments: false,
        is_false_positive: false,
      } as NewCommunication);
      restoredCount++;
    }

    await logService.info(
      "Removed email(s) restored",
      "TransactionService.restoreRemovedEmailThread",
      {
        ignoredCommId,
        transactionId,
        threadId: resolvedThreadId,
        threadExpansion: isEmailThread,
        restoredCount,
      },
    );

    return { restoredCount };
  }

  /**
   * Re-analyze a specific property (rescan emails for that address)
   */
  async reanalyzeProperty(
    userId: string,
    provider: OAuthProvider,
    propertyAddress: string,
    dateRange: DateRange = {},
  ): Promise<ReanalysisResult> {
    const emails = await this._fetchEmails(userId, provider, {
      query: propertyAddress,
      after:
        dateRange.start || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      before: dateRange.end || new Date(),
    });

    const emailsForAnalysis = emails.map((email) => ({
      subject: email.subject || undefined,
      from: email.from || undefined,
      to: email.to || undefined,
      body: email.body,
      bodyPlain: email.bodyPlain,
      snippet: email.snippet,
      bodyPreview: email.bodyPreview,
      date: email.date || new Date().toISOString(),
    }));
    const analyzed = transactionExtractorService.batchAnalyze(emailsForAnalysis);
    const realEstateEmails = analyzed.filter((a) => a.isRealEstateRelated);

    return {
      emailsFound: emails.length,
      realEstateEmailsFound: realEstateEmails.length,
      analyzed: realEstateEmails.map((result) => ({
        subject: result.subject,
        from: result.from || "",
        date: result.date,
        isRealEstateRelated: result.isRealEstateRelated,
        keywords: Array.isArray(result.keywords)
          ? result.keywords.map((k) => k.keyword).join(", ")
          : undefined,
        parties: Array.isArray(result.parties)
          ? result.parties.map((p) => p.name || p.email || "").join(", ")
          : undefined,
        confidence: result.confidence,
      })),
    };
  }

  // ============================================
  // MESSAGE LINKING METHODS
  // ============================================

  /**
   * Get unlinked messages for a user
   */
  async getUnlinkedMessages(userId: string): Promise<Message[]> {
    const messages = await databaseService.getUnlinkedTextMessages(userId);

    await logService.info(
      "Retrieved unlinked messages",
      "TransactionService.getUnlinkedMessages",
      {
        userId,
        count: messages.length,
      },
    );

    return messages;
  }

  /**
   * Get unlinked emails for a user
   */
  async getUnlinkedEmails(userId: string): Promise<Communication[]> {
    const emails = await databaseService.getUnlinkedEmails(userId);

    await logService.info(
      "Retrieved unlinked emails",
      "TransactionService.getUnlinkedEmails",
      {
        userId,
        count: emails.length,
      },
    );

    return emails;
  }

  /**
   * Get distinct contacts with unlinked message counts
   */
  async getMessageContacts(userId: string): Promise<{ contact: string; contactName: string | null; messageCount: number; lastMessageAt: string }[]> {
    const contacts = await databaseService.getMessageContacts(userId);

    let contactNameMap: Record<string, string> = {};

    if (process.platform === 'darwin') {
      try {
        const { contactMap } = await getContactNames();
        contactNameMap = contactMap;
      } catch (err) {
        await logService.warn(
          "Failed to load contact names from macOS Contacts, falling back to external_contacts",
          "TransactionService.getMessageContacts",
          { error: err instanceof Error ? err.message : String(err) },
        );
        contactNameMap = this._getContactNameMapFromExternalContacts(userId);
      }
    } else {
      contactNameMap = this._getContactNameMapFromExternalContacts(userId);
    }

    // BACKLOG-1547: Also merge names from app's own contacts + contact_phones table
    const appContactNames = await this._getContactNameMapFromAppContacts(userId);
    for (const [key, value] of Object.entries(appContactNames)) {
      if (!contactNameMap[key]) {
        contactNameMap[key] = value;
      }
    }

    const enrichedContacts = contacts.map((c) => {
      // BACKLOG-1547: Try 4 normalization variants for phone-to-name resolution
      const raw = c.contact;
      const digitsOnly = raw.replace(/\D/g, '');
      const last10 = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : '';
      const e164 = digitsOnly.length === 10 ? `+1${digitsOnly}` : digitsOnly.length > 10 ? `+${digitsOnly}` : '';

      const name =
        contactNameMap[raw] ||
        contactNameMap[digitsOnly] ||
        (last10 && contactNameMap[last10]) ||
        (e164 && contactNameMap[e164]) ||
        null;
      return {
        ...c,
        contactName: name,
      };
    });

    await logService.info(
      "Retrieved message contacts",
      "TransactionService.getMessageContacts",
      {
        userId,
        contactCount: contacts.length,
        withNames: enrichedContacts.filter(c => c.contactName).length,
        platform: process.platform,
      },
    );

    return enrichedContacts;
  }

  /**
   * Build a phone number to name map from external_contacts table
   */
  private _getContactNameMapFromExternalContacts(userId: string): Record<string, string> {
    const externalContacts = externalContactDb.getAllForUser(userId);
    const map: Record<string, string> = {};

    for (const contact of externalContacts) {
      if (!contact.name) continue;

      for (const phone of contact.phones) {
        map[phone] = contact.name;

        const digitsOnly = phone.replace(/\D/g, '');
        if (digitsOnly.length >= 10) {
          const last10 = digitsOnly.slice(-10);
          map[last10] = contact.name;
          map[digitsOnly] = contact.name;
        }
      }
    }

    return map;
  }

  /**
   * BACKLOG-1547: Build a phone number to name map from app's contacts + contact_phones tables
   * This catches contacts that were imported/synced into the app but might not be
   * in macOS Contacts or external_contacts.
   */
  private async _getContactNameMapFromAppContacts(userId: string): Promise<Record<string, string>> {
    try {
      const contacts = await databaseService.getImportedContactsByUserId(userId);
      const map: Record<string, string> = {};

      for (const contact of contacts) {
        const name = contact.display_name || contact.name;
        if (!name) continue;

        // Map primary phone
        if (contact.phone) {
          map[contact.phone] = name;
          const digitsOnly = contact.phone.replace(/\D/g, '');
          if (digitsOnly.length >= 10) {
            map[digitsOnly] = name;
            map[digitsOnly.slice(-10)] = name;
            if (digitsOnly.length === 10) {
              map[`+1${digitsOnly}`] = name;
            } else if (digitsOnly.length > 10) {
              map[`+${digitsOnly}`] = name;
            }
          }
        }

        // Map all phones from contact_phones table
        if (contact.allPhones) {
          for (const phone of contact.allPhones) {
            map[phone] = name;
            const digitsOnly = phone.replace(/\D/g, '');
            if (digitsOnly.length >= 10) {
              map[digitsOnly] = name;
              map[digitsOnly.slice(-10)] = name;
              if (digitsOnly.length === 10) {
                map[`+1${digitsOnly}`] = name;
              } else if (digitsOnly.length > 10) {
                map[`+${digitsOnly}`] = name;
              }
            }
          }
        }
      }

      return map;
    } catch (err) {
      logService.warn(
        "Failed to load contact names from app contacts table",
        "TransactionService._getContactNameMapFromAppContacts",
        { error: err instanceof Error ? err.message : String(err) },
      );
      return {};
    }
  }

  /**
   * Get unlinked messages for a specific contact
   */
  async getMessagesByContact(userId: string, contact: string): Promise<Message[]> {
    const messages = await databaseService.getMessagesByContact(userId, contact);

    await logService.info(
      "Retrieved messages for contact",
      "TransactionService.getMessagesByContact",
      {
        userId,
        contact,
        count: messages.length,
      },
    );

    return messages;
  }

  /**
   * Link messages to a transaction
   */
  async linkMessages(messageIds: string[], transactionId: string): Promise<void> {
    const transaction = await this.getTransactionDetails(transactionId);
    if (!transaction) {
      throw new Error("Transaction not found");
    }

    let linkedCount = 0;

    for (const messageId of messageIds) {
      await databaseService.linkMessageToTransaction(messageId, transactionId);

      const refId = await createCommunicationReference(
        messageId,
        transactionId,
        transaction.user_id,
        "manual",
        1.0
      );

      if (refId) {
        linkedCount++;
      }
    }

    const newCount = (transaction.message_count || 0) + linkedCount;
    await databaseService.updateTransaction(transactionId, {
      message_count: newCount,
    });

    await logService.info(
      "Messages linked to transaction",
      "TransactionService.linkMessages",
      {
        messageIds,
        transactionId,
        linkedCount,
      },
    );
  }

  /**
   * Unlink messages from a transaction
   * BACKLOG-1560: Now records thread-level suppression in ignored_communications
   * to prevent auto-link from re-adding unlinked threads on subsequent syncs.
   */
  async unlinkMessages(messageIds: string[], passedTransactionId?: string): Promise<void> {
    const transactionCounts = new Map<string, number>();
    const transactionThreads = new Map<string, Set<string>>();
    // BACKLOG-1560: Track user_id per transaction for ignored_communications records
    const transactionUsers = new Map<string, string>();
    // BACKLOG-1560: Track messages without valid thread_id for per-message suppression
    const transactionThreadlessMessages = new Map<string, Set<string>>();

    for (const messageId of messageIds) {
      const message = await databaseService.getMessageById(messageId);

      const transactionId = passedTransactionId || message?.transaction_id;

      if (transactionId) {
        // BACKLOG-2150 — linked messages (texts) are add-AND-remove after first
        // export, like emails. Unlinking from a frozen (property, type, start)
        // transaction cannot enable deal reuse, so the earlier add-only detach
        // guard was removed.

        const count = transactionCounts.get(transactionId) || 0;
        transactionCounts.set(transactionId, count + 1);

        // BACKLOG-1560: Treat empty string thread_id the same as null
        if (message?.thread_id && message.thread_id !== "") {
          let threads = transactionThreads.get(transactionId);
          if (!threads) {
            threads = new Set<string>();
            transactionThreads.set(transactionId, threads);
          }
          threads.add(message.thread_id);
        } else {
          // BACKLOG-1560: Message has no valid thread_id - track for per-message suppression
          let threadless = transactionThreadlessMessages.get(transactionId);
          if (!threadless) {
            threadless = new Set<string>();
            transactionThreadlessMessages.set(transactionId, threadless);
          }
          threadless.add(messageId);
        }

        // BACKLOG-1560: Capture user_id for suppression records
        if (message?.user_id && !transactionUsers.has(transactionId)) {
          transactionUsers.set(transactionId, message.user_id);
        }
      }
    }

    // BACKLOG-1560 FIX: Record suppression BEFORE deleting communication records.
    // Previous attempts deleted comms first, then if suppression INSERT failed,
    // the communication was already gone and auto-link would re-add it.

    // Record thread-level suppression so auto-link skips these threads
    for (const [transactionId, threadIds] of transactionThreads) {
      const userId = transactionUsers.get(transactionId);
      if (userId) {
        for (const threadId of threadIds) {
          try {
            await logService.debug("[BACKLOG-1560] Recording suppression", "TransactionService", {
              transactionId, threadId, userId
            });
            await databaseService.addIgnoredCommunication({
              user_id: userId,
              transaction_id: transactionId,
              thread_id: threadId,
              reason: "Manually unlinked by user",
            });
          } catch (error) {
            await logService.warn(
              `[BACKLOG-1560] Failed to record thread suppression: ${error instanceof Error ? error.message : "Unknown"}`,
              "TransactionService",
              { transactionId, threadId }
            );
          }
        }
      }

      await logService.debug("[BACKLOG-1560] Suppression records created", "TransactionService", {
        transactionId, threadIds: Array.from(threadIds)
      });
    }

    // Record per-message suppression for messages without valid thread_id
    for (const [transactionId, msgIds] of transactionThreadlessMessages) {
      const userId = transactionUsers.get(transactionId);
      if (userId) {
        for (const msgId of msgIds) {
          try {
            await logService.debug("[BACKLOG-1560] Recording suppression (no thread_id)", "TransactionService", {
              transactionId, messageId: msgId, userId
            });
            await databaseService.addIgnoredCommunication({
              user_id: userId,
              transaction_id: transactionId,
              original_communication_id: msgId,
              reason: "Manually unlinked by user (no thread_id)",
            });
          } catch (error) {
            await logService.warn(
              `[BACKLOG-1560] Failed to record message suppression: ${error instanceof Error ? error.message : "Unknown"}`,
              "TransactionService",
              { transactionId, messageId: msgId }
            );
          }
        }
      }
    }

    // NOW delete communication records and unlink messages (after suppression is recorded)
    for (const messageId of messageIds) {
      const message = await databaseService.getMessageById(messageId);
      if (message?.transaction_id) {
        await databaseService.unlinkMessageFromTransaction(messageId);
      }
      await databaseService.deleteCommunicationByMessageId(messageId);
    }

    // Delete thread-level communication records
    for (const [transactionId, threadIds] of transactionThreads) {
      for (const threadId of threadIds) {
        await databaseService.deleteCommunicationByThread(threadId, transactionId);
      }
    }

    for (const [transactionId, unlinkedCount] of transactionCounts) {
      const transaction = await this.getTransactionDetails(transactionId);
      if (transaction) {
        const newCount = Math.max(0, (transaction.message_count || 0) - unlinkedCount);
        await databaseService.updateTransaction(transactionId, {
          message_count: newCount,
        });
      }
    }

    await logService.info(
      "Messages unlinked from transaction",
      "TransactionService.unlinkMessages",
      {
        unlinkedCount: messageIds.length,
        threadsUnlinked: Array.from(transactionThreads.values()).reduce((sum, threads) => sum + threads.size, 0),
        threadlessMessagesSuppressed: Array.from(transactionThreadlessMessages.values()).reduce((sum, msgs) => sum + msgs.size, 0),
      },
    );
  }
}

export default new TransactionService();
