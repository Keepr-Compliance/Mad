import axios, { AxiosRequestConfig } from "axios";
import * as Sentry from "@sentry/electron/main";
import databaseService from "./databaseService";
import logService from "./logService";
import microsoftAuthService from "./microsoftAuthService";
import { OAuthToken, ParsedParticipant } from "../types/models";
import { computeEmailHash } from "../utils/emailHash";
import { normalizeEmailAddress } from "../utils/emailAddress";
import { EmailDeduplicationService } from "./emailDeduplicationService";
import {
  withRetry,
  apiThrottlers,
  RetryOptions,
} from "../utils/apiRateLimit";

/**
 * Microsoft Graph API email recipient
 */
interface GraphEmailRecipient {
  emailAddress?: {
    address: string;
    name?: string;
  };
}

/**
 * Microsoft Graph API email body
 */
interface GraphEmailBody {
  content: string;
  contentType: "text" | "html";
}

/**
 * Microsoft Graph internet message header
 */
interface GraphInternetMessageHeader {
  name: string;
  value: string;
}

/**
 * Microsoft Graph API message
 */
interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  from?: GraphEmailRecipient;
  toRecipients?: GraphEmailRecipient[];
  ccRecipients?: GraphEmailRecipient[];
  bccRecipients?: GraphEmailRecipient[];
  receivedDateTime: string;
  sentDateTime: string;
  hasAttachments: boolean;
  body?: GraphEmailBody;
  bodyPreview?: string;
  // TASK-502: Added for junk detection
  inferenceClassification?: 'focused' | 'other';
  parentFolderId?: string;
  // TASK-917: Added for Message-ID extraction (deduplication)
  internetMessageId?: string;
  internetMessageHeaders?: GraphInternetMessageHeader[];
}

/**
 * Microsoft Graph API response wrapper
 */
interface GraphApiResponse<T> {
  value: T[];
  "@odata.count"?: number;
  "@odata.nextLink"?: string;
}

/**
 * Progress callback for email fetching
 */
interface FetchProgress {
  fetched: number;
  total: number;
  estimatedTotal?: number;
  percentage: number;
  hasEstimate: boolean;
}

/**
 * Microsoft Graph attachment
 */
interface GraphAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  contentBytes?: string;
}

/**
 * Parsed email message
 */
interface ParsedEmail {
  id: string;
  threadId: string;
  subject: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  date: Date;
  sentDate: Date;
  body: string;
  bodyPlain: string;
  snippet: string;
  hasAttachments: boolean;
  attachmentCount: number;
  raw: GraphMessage;
  // TASK-502: Added for junk detection
  inferenceClassification?: string;
  parentFolderId?: string;
  /** RFC 5322 Message-ID header for deduplication (TASK-917) */
  messageIdHeader: string | null;
  /** SHA-256 content hash for fallback deduplication (TASK-918) */
  contentHash: string;
  /** ID of the original message if this is a duplicate (TASK-919) */
  duplicateOf?: string;
  /** Attachment metadata for download */
  attachments?: { filename: string; mimeType: string; size: number; attachmentId: string }[];
  /**
   * BACKLOG-1722: Structured participants for the email_participants junction.
   * Built directly from Graph API's `emailAddress.{name,address}` fields
   * (no parser needed — Outlook gives us structured data).
   */
  participants: ParsedParticipant[];
}

/**
 * Search options for email queries
 */
interface EmailSearchOptions {
  query?: string;
  after?: Date | null;
  before?: Date | null;
  maxResults?: number;
  skip?: number;
  contactEmails?: string[];
  onProgress?: (progress: FetchProgress) => void;
}

/**
 * Extract RFC 5322 Message-ID header from Outlook message
 * Uses internetMessageId property first (preferred), falls back to internetMessageHeaders
 * @param message - Graph API message object
 * @returns Message-ID header value or null if not found
 */
function extractMessageIdHeader(message: GraphMessage): string | null {
  // Option 1: Use internetMessageId property (preferred, simpler)
  if (message.internetMessageId) {
    return message.internetMessageId;
  }

  // Option 2: Fall back to internetMessageHeaders array
  if (message.internetMessageHeaders && message.internetMessageHeaders.length > 0) {
    const messageIdHeader = message.internetMessageHeaders.find(
      (h) => h.name?.toLowerCase() === "message-id",
    );
    if (messageIdHeader?.value) {
      return messageIdHeader.value;
    }
  }

  return null;
}

/**
 * Microsoft Graph API contact (TASK-1920)
 */
interface GraphContact {
  id: string;
  displayName?: string;
  emailAddresses?: Array<{
    address?: string;
    name?: string;
  }>;
  mobilePhone?: string | null;
  homePhones?: string[];
  businessPhones?: string[];
  companyName?: string | null;
}

/**
 * Mapped Outlook contact matching external_contacts schema (TASK-1920)
 */
export interface OutlookContact {
  external_record_id: string;
  name: string | null;
  emails: string[];
  phones: string[];
  company: string | null;
}

/**
 * Result of a contacts fetch operation (TASK-1920)
 */
export interface FetchContactsResult {
  success: boolean;
  contacts: OutlookContact[];
  error?: string;
  reconnectRequired?: boolean;
}

/**
 * Outlook Fetch Service
 * Fetches emails from Outlook/Office 365 using Microsoft Graph API
 */
class OutlookFetchService {
  private graphApiUrl = "https://graph.microsoft.com/v1.0";
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private userId: string | null = null;

  /**
   * Initialize Outlook API with user's OAuth tokens
   * @param userId - User ID to fetch tokens for
   */
  async initialize(userId: string): Promise<boolean> {
    try {
      this.userId = userId;

      // Get OAuth token from database
      const tokenRecord: OAuthToken | null =
        await databaseService.getOAuthToken(userId, "microsoft", "mailbox");

      if (!tokenRecord) {
        throw new Error(
          "No Outlook OAuth token found. User needs to connect Outlook first.",
        );
      }

      // Session-only OAuth: tokens stored unencrypted in encrypted database
      this.accessToken = tokenRecord.access_token || "";
      this.refreshToken = tokenRecord.refresh_token || null;

      logService.debug("Initialized successfully", "OutlookFetch");
      return true;
    } catch (error) {
      logService.error("Initialization failed", "OutlookFetch", { error });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "initialize" },
      });
      throw error;
    }
  }

  /**
   * Make authenticated request to Microsoft Graph API with rate limiting
   *
   * Features (BACKLOG-497):
   * - Request throttling (100ms minimum delay between requests)
   * - Exponential backoff on rate limit errors (429)
   * - Respects Retry-After headers
   * - Automatic retry on transient errors
   *
   * @private
   */
  private async _graphRequest<T = any>(
    endpoint: string,
    method: string = "GET",
    data: any = null,
    isRetry: boolean = false,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    // Throttle requests to avoid rate limiting (BACKLOG-497)
    await apiThrottlers.microsoftGraph.throttle();

    const retryOptions: RetryOptions = {
      maxRetries: 5,
      baseDelay: 1000,
      maxDelay: 30000,
      context: "OutlookFetch",
    };

    return withRetry(async () => {
      try {
        const config: AxiosRequestConfig = {
          method,
          url: `${this.graphApiUrl}${endpoint}`,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
            ...extraHeaders,
          },
          // TASK-2056: 15-second timeout to prevent hanging when offline
          timeout: 15000,
        };

        if (data) {
          config.data = data;
        }

        const response = await axios(config);
        return response.data;
      } catch (error: unknown) {
        // TASK-2273: Sentry breadcrumbs for Graph API errors
        const axiosErr = error as {
          response?: { status?: number; headers?: Record<string, string>; data?: { error?: { code?: string; message?: string } } };
        };
        if (axiosErr.response) {
          const status = axiosErr.response.status;
          if (status === 429) {
            // Rate limit — breadcrumb only (warning, not error; retried by withRetry)
            const retryAfter = axiosErr.response.headers?.["retry-after"] ?? "unknown";
            Sentry.addBreadcrumb({
              category: "email_sync.rate_limit",
              message: `Outlook Graph API rate limited (429)`,
              level: "warning",
              data: {
                provider: "outlook",
                component: "email_sync",
                retryAfter,
                endpoint,
              },
            });
          } else if (status && status >= 400) {
            // Other API errors — include status + error code in Sentry extra
            const errorCode = axiosErr.response.data?.error?.code ?? "unknown";
            const errorMessage = axiosErr.response.data?.error?.message ?? "";
            Sentry.addBreadcrumb({
              category: "email_sync.api_error",
              message: `Outlook Graph API error: ${status}`,
              level: "error",
              data: {
                provider: "outlook",
                component: "email_sync",
                responseStatus: status,
                errorCode,
                errorMessage: errorMessage.substring(0, 200),
                endpoint,
              },
            });
          }
        }

        // Handle token expiration with refresh
        if (axiosErr.response && axiosErr.response.status === 401 && !isRetry) {
          if (this.refreshToken && this.userId) {
            logService.info(
              "Access token expired, attempting refresh",
              "OutlookFetch",
            );
            try {
              const tokenResponse = await microsoftAuthService.refreshToken(
                this.refreshToken,
              );
              this.accessToken = tokenResponse.access_token;
              this.refreshToken = tokenResponse.refresh_token;

              // Update token in database
              await databaseService.saveOAuthToken(
                this.userId,
                "microsoft",
                "mailbox",
                {
                  access_token: tokenResponse.access_token,
                  refresh_token: tokenResponse.refresh_token,
                  token_expires_at: new Date(
                    Date.now() + tokenResponse.expires_in * 1000,
                  ).toISOString(),
                },
              );

              logService.info("Token refreshed successfully", "OutlookFetch");
              // Retry the request with new token (mark as retry to avoid infinite loop)
              return this._graphRequest<T>(endpoint, method, data, true);
            } catch (refreshError) {
              logService.error("Token refresh failed", "OutlookFetch", {
                error: refreshError,
              });
              Sentry.captureException(refreshError, {
                tags: { service: "outlook-fetch", operation: "_graphRequest.tokenRefresh" },
              });
              throw new Error(
                "Microsoft access token expired and refresh failed. Please reconnect Outlook.",
              );
            }
          } else {
            logService.error(
              "Access token expired but no refresh token available",
              "OutlookFetch",
            );
            throw new Error(
              "Microsoft access token expired. Please reconnect Outlook.",
            );
          }
        }
        throw error;
      }
    }, retryOptions);
  }

  /**
   * Search for emails matching query
   * @param options - Search options
   * @returns Array of email messages
   */
  async searchEmails({
    query = "",
    after = null,
    before = null,
    maxResults,
    skip: initialSkip = 0,
    contactEmails,
    onProgress,
  }: EmailSearchOptions = {}): Promise<ParsedEmail[]> {
    try {
      if (!this.accessToken) {
        throw new Error(
          "Outlook API not initialized. Call initialize() first.",
        );
      }

      // Build Graph API query params
      // Key constraint: $search cannot be combined with $filter or $orderby
      // Modes:
      //   1. Text search: $search only, date filter client-side
      //   2. Contact filter: $filter for from + dates, no $orderby
      //   3. No query: $filter for dates + $orderby
      const filters: string[] = [];
      const hasContactFilter = contactEmails && contactEmails.length > 0;
      const hasTextQuery = !!query;
      let searchParam = "";

      // Store date params for client-side filtering when $search is used
      const clientDateFilter = { after, before };

      if (hasTextQuery) {
        // Use $search for text — cannot combine with $filter at all
        const sanitized = query.replace(/"/g, "").trim();
        searchParam = `$search="${sanitized}"`;
        // No $filter allowed — dates will be filtered client-side
      } else if (hasContactFilter) {
        // Contact filter via $filter (no text query)
        const fromClauses = contactEmails!.map((email) => {
          const escaped = email.replace(/'/g, "''");
          return `from/emailAddress/address eq '${escaped}'`;
        });
        filters.push(`(${fromClauses.join(" or ")})`);
        if (after) filters.push(`receivedDateTime ge ${after.toISOString()}`);
        if (before) filters.push(`receivedDateTime le ${before.toISOString()}`);
      } else {
        // No search, no contacts — just date filter
        if (after) filters.push(`receivedDateTime ge ${after.toISOString()}`);
        if (before) filters.push(`receivedDateTime le ${before.toISOString()}`);
      }

      const filterString =
        filters.length > 0 ? `$filter=${filters.join(" and ")}` : "";
      const needsClientSort = hasTextQuery || hasContactFilter;
      const orderBy = needsClientSort ? "" : "$orderby=receivedDateTime desc";
      const selectFields =
        "$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,hasAttachments,body,bodyPreview,conversationId,inferenceClassification,parentFolderId,internetMessageId,internetMessageHeaders";

      logService.info("Searching emails", "OutlookFetch", {
        originalQuery: query,
        searchParam: searchParam || '(none)',
        filterString: filterString || '(none)',
        contactCount: contactEmails?.length || 0,
        hasQuery: !!query,
        hasDateFilter: filters.length > 0,
        needsClientSort,
      });

      // First, get the total count of matching emails
      // $count is not supported with $search, so skip when using text search
      let estimatedTotal = 0;
      if (!searchParam) {
        try {
          const countParams = ["$count=true", "$top=1", filterString]
            .filter(Boolean)
            .join("&");
          const countData = await this._graphRequest<
            GraphApiResponse<GraphMessage>
          >(`/me/messages?${countParams}`);
          estimatedTotal = countData["@odata.count"] || 0;
          logService.info(
            `Estimated total emails: ${estimatedTotal}`,
            "OutlookFetch",
          );
        } catch {
          logService.debug(
            "Could not get email count, progress will be estimated",
            "OutlookFetch",
          );
        }
      }

      const hasEstimate = estimatedTotal > 0;
      const targetTotal = hasEstimate
        ? (maxResults ? Math.min(estimatedTotal, maxResults) : estimatedTotal)
        : (maxResults || 0);

      const allMessages: GraphMessage[] = [];
      let skip = initialSkip;
      let pageCount = 0;
      const pageSize = 100; // Fetch 100 per page

      logService.info("Outlook search starting", "OutlookFetch", {
        initialSkip,
        maxResults: maxResults || "unlimited",
        hasSearch: !!searchParam,
        hasFilter: !!filterString,
      });

      // Paginate through all results (bounded by date filters, not count)
      do {
        pageCount++;
        const top = `$top=${pageSize}`;
        // $skip causes 400 when combined with $search on /me/messages (Graph API)
        // Use @odata.nextLink for pagination when $search is active
        const skipParam = (!searchParam && skip > 0) ? `$skip=${skip}` : "";

        const queryParams = [selectFields, orderBy, top, skipParam, filterString, searchParam]
          .filter(Boolean)
          .join("&");

        logService.debug(
          `Fetching page ${pageCount} (skip=${skip})`,
          "OutlookFetch",
        );

        const data = await this._graphRequest<GraphApiResponse<GraphMessage>>(
          `/me/messages?${queryParams}`,
        );
        const messages = data.value || [];

        logService.debug(
          `Page ${pageCount}: Found ${messages.length} messages`,
          "OutlookFetch",
        );

        allMessages.push(...messages);
        skip += pageSize;

        // Report progress
        if (onProgress) {
          const fetched = allMessages.length;
          const currentTotal = hasEstimate ? targetTotal : fetched;
          const percentage = hasEstimate
            ? Math.min(100, Math.round((fetched / targetTotal) * 100))
            : 0;
          onProgress({
            fetched,
            total: currentTotal,
            estimatedTotal,
            percentage,
            hasEstimate,
          });
        }

        // Stop if we got fewer results than a full page or reached maxResults (if set)
        if (messages.length < pageSize) {
          break;
        }
        if (maxResults && allMessages.length >= maxResults) {
          break;
        }
      } while (true);

      logService.info(
        `Total messages found: ${allMessages.length}`,
        "OutlookFetch",
      );

      // Parse messages (apply maxResults cap only if explicitly set)
      const messagesToParse = maxResults ? allMessages.slice(0, maxResults) : allMessages;
      let parsed = messagesToParse.map((msg) => this._parseMessage(msg));

      // When $search is used, dates couldn't be in $filter — filter client-side
      if (searchParam && (clientDateFilter.after || clientDateFilter.before)) {
        parsed = parsed.filter((email) => {
          if (clientDateFilter.after && email.date < clientDateFilter.after) return false;
          if (clientDateFilter.before && email.date > clientDateFilter.before) return false;
          return true;
        });
      }

      // When $orderby isn't available ($search or contact filter), sort client-side
      if (needsClientSort) {
        parsed.sort((a, b) => b.date.getTime() - a.date.getTime());
      }

      return parsed;
    } catch (error) {
      logService.error("Search emails failed", "OutlookFetch", { error });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "searchEmails", provider: "outlook", component: "email_sync" },
      });
      throw error;
    }
  }

  /**
   * Search sent items for emails TO specific contact email addresses.
   * Uses $search with "to:" KQL which works on sentItems folder.
   * Limited to maxResults per contact email to avoid over-fetching.
   *
   * TASK-2060: Added after parameter for date-range filtering. When provided,
   * results are filtered client-side since $search cannot combine with $filter.
   *
   * @param contactEmails - Contact email addresses to search for
   * @param maxResults - Maximum results per contact email (default 50)
   * @param after - Optional date to filter emails received after this date
   */
  async searchSentEmailsToContacts(
    contactEmails: string[],
    maxResults: number = 50,
    after?: Date | null,
  ): Promise<ParsedEmail[]> {
    if (!this.accessToken) {
      throw new Error("Outlook API not initialized. Call initialize() first.");
    }

    const allParsed: ParsedEmail[] = [];
    const seenIds = new Set<string>();
    const selectFields =
      "$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,hasAttachments,body,bodyPreview,conversationId,inferenceClassification,parentFolderId,internetMessageId,internetMessageHeaders";

    for (const email of contactEmails) {
      try {
        // KQL search: "to:" finds emails where the address is in recipients
        const searchQuery = `$search="to:${email}"`;
        const top = `$top=${maxResults}`;
        const queryParams = [selectFields, top, searchQuery]
          .filter(Boolean)
          .join("&");

        const data = await this._graphRequest<GraphApiResponse<GraphMessage>>(
          `/me/mailFolders/sentItems/messages?${queryParams}`,
        );
        const messages = data.value || [];

        logService.info(
          `Sent items search for "${email}": found ${messages.length}`,
          "OutlookFetch",
        );

        for (const msg of messages) {
          if (!seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            const parsed = this._parseMessage(msg);
            // TASK-2060: Client-side date filter since $search can't combine with $filter
            if (after && parsed.date < after) {
              continue;
            }
            allParsed.push(parsed);
          }
        }
      } catch (searchError) {
        logService.warn(
          `Sent items search failed for "${email}"`,
          "OutlookFetch",
          { error: searchError instanceof Error ? searchError.message : "Unknown" },
        );
        Sentry.captureException(searchError, {
          tags: { service: "outlook-fetch", operation: "searchSentEmailsToContacts" },
        });
      }
    }

    return allParsed;
  }

  /**
   * Get email by ID
   * @param messageId - Outlook message ID
   * @returns Parsed email object
   */
  async getEmailById(messageId: string): Promise<ParsedEmail> {
    try {
      // Expand attachments so we get attachment metadata in one call
      const data = await this._graphRequest<GraphMessage & { attachments?: GraphAttachment[] }>(
        `/me/messages/${messageId}?$expand=attachments`,
      );
      const parsed = this._parseMessage(data);

      // Map Graph attachments to our format
      if (data.attachments && data.attachments.length > 0) {
        parsed.attachments = data.attachments
          .filter(att => att.name && att.id) // Skip malformed entries
          .map(att => ({
            filename: att.name,
            mimeType: att.contentType || "application/octet-stream",
            size: att.size || 0,
            attachmentId: att.id,
          }));
        parsed.attachmentCount = parsed.attachments.length;
      }

      return parsed;
    } catch (error) {
      logService.error(`Failed to get message ${messageId}`, "OutlookFetch", {
        error,
      });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "getEmailById" },
      });
      throw error;
    }
  }

  /**
   * Parse Outlook message into structured format
   * @private
   */
  private _parseMessage(message: GraphMessage): ParsedEmail {
    // Extract email addresses
    const getEmailAddress = (
      recipient: GraphEmailRecipient | undefined | null,
    ): string | null => {
      if (!recipient) return null;
      return recipient.emailAddress ? recipient.emailAddress.address : null;
    };

    // Format from as "Name <email>" when display name is available
    const from = message.from?.emailAddress
      ? (message.from.emailAddress.name
        ? `${message.from.emailAddress.name} <${message.from.emailAddress.address}>`
        : message.from.emailAddress.address)
      : null;
    const to = message.toRecipients
      ? message.toRecipients.map(getEmailAddress).join(", ")
      : null;
    const cc = message.ccRecipients
      ? message.ccRecipients.map(getEmailAddress).join(", ")
      : null;
    const bcc = message.bccRecipients
      ? message.bccRecipients.map(getEmailAddress).join(", ")
      : null;

    // Extract body
    const body = message.body ? message.body.content : "";
    const bodyPlain =
      message.body && message.body.contentType === "text"
        ? message.body.content
        : message.bodyPreview || "";

    // Use sentDateTime for hash (consistent with Gmail using internalDate)
    const sentDate = new Date(message.sentDateTime);

    // Compute content hash for deduplication fallback (TASK-918)
    const contentHash = computeEmailHash({
      subject: message.subject,
      from,
      sentDate,
      bodyPlain,
    });

    // BACKLOG-1722: Build structured participants from Graph's already-
    // structured `emailAddress.{address,name}` fields. Preserves header
    // order (used as the junction-table `position` column).
    const participants: ParsedParticipant[] = [];
    const pushParticipant = (
      recipient: GraphEmailRecipient | undefined | null,
      role: "from" | "to" | "cc" | "bcc",
      position: number,
    ): void => {
      const addr = recipient?.emailAddress?.address;
      if (!addr) return;
      const normalized = normalizeEmailAddress(addr);
      if (!normalized || normalized.indexOf("@") < 1 || normalized.endsWith("@")) return;
      participants.push({
        email_address: normalized,
        display_name: recipient?.emailAddress?.name ?? null,
        role,
        position,
      });
    };
    pushParticipant(message.from, "from", 0);
    (message.toRecipients ?? []).forEach((r, i) => pushParticipant(r, "to", i));
    (message.ccRecipients ?? []).forEach((r, i) => pushParticipant(r, "cc", i));
    (message.bccRecipients ?? []).forEach((r, i) => pushParticipant(r, "bcc", i));

    const parsed: ParsedEmail = {
      id: message.id,
      threadId: message.conversationId,
      subject: message.subject,
      from: from,
      to: to,
      cc: cc,
      bcc: bcc,
      date: new Date(message.receivedDateTime),
      sentDate: sentDate,
      body: body,
      bodyPlain: bodyPlain,
      snippet: message.bodyPreview || "",
      hasAttachments: message.hasAttachments || false,
      attachmentCount: 0, // Would need separate call to get attachment count
      raw: message,
      participants,
      // TASK-502: Added for junk detection
      inferenceClassification: message.inferenceClassification,
      parentFolderId: message.parentFolderId,
      // TASK-917: Message-ID for deduplication
      messageIdHeader: extractMessageIdHeader(message),
      // TASK-918: Content hash for fallback deduplication
      contentHash,
    };

    // BACKLOG-1125: Clear raw message reference after parsing to reduce memory.
    // During sync of 500+ emails, keeping the full Graph API response doubles usage.
    parsed.raw = {} as GraphMessage;

    return parsed;
  }

  /**
   * Get email attachments
   * @param messageId - Outlook message ID
   * @returns Array of attachments
   */
  async getAttachments(messageId: string): Promise<GraphAttachment[]> {
    try {
      const data = await this._graphRequest<GraphApiResponse<GraphAttachment>>(
        `/me/messages/${messageId}/attachments`,
      );
      return data.value || [];
    } catch (error) {
      logService.error("Failed to get attachments", "OutlookFetch", { error });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "getAttachments" },
      });
      throw error;
    }
  }

  /**
   * Get specific attachment
   * @param messageId - Outlook message ID
   * @param attachmentId - Attachment ID
   * @returns Attachment data, or null if the attachment could not be fetched
   */
  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer | null> {
    try {
      const data = await this._graphRequest<GraphAttachment>(
        `/me/messages/${messageId}/attachments/${attachmentId}`,
      );

      if (data.contentBytes) {
        return Buffer.from(data.contentBytes, "base64");
      }

      // Permanent failure: API returned successfully but no data.
      // Log to Sentry and skip -- do NOT retry (ELECTRON-16).
      logService.warn(
        "Outlook attachment: no data returned, skipping",
        "OutlookFetch",
        { messageId, attachmentId, contentType: data.contentType ?? "unknown" },
      );
      Sentry.addBreadcrumb({
        category: "email_sync.attachment",
        message: "Outlook attachment: no data returned",
        level: "warning",
        data: {
          provider: "outlook",
          component: "email_sync",
          messageId,
          attachmentId,
          contentType: data.contentType ?? "unknown",
          size: data.size ?? 0,
        },
      });
      Sentry.captureMessage("Outlook attachment: no data returned", {
        level: "warning",
        tags: { service: "outlook-fetch", operation: "getAttachment" },
        extra: {
          messageId,
          attachmentId,
          contentType: data.contentType ?? "unknown",
          size: data.size ?? 0,
        },
      });
      return null;
    } catch (error) {
      // Network/API errors that exhausted _graphRequest retries.
      // Log with enriched context and skip gracefully (ELECTRON-16).
      logService.error("Failed to get attachment, skipping", "OutlookFetch", {
        messageId,
        attachmentId,
        error,
      });
      Sentry.addBreadcrumb({
        category: "email_sync.attachment",
        message: "Outlook attachment fetch failed",
        level: "error",
        data: {
          provider: "outlook",
          component: "email_sync",
          messageId,
          attachmentId,
          errorType: error instanceof Error ? error.constructor.name : "unknown",
        },
      });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "getAttachment" },
        extra: { messageId, attachmentId },
      });
      return null;
    }
  }

  /**
   * Get user's email address
   * @returns User's Outlook email address
   */
  async getUserEmail(): Promise<string> {
    try {
      const data = await this._graphRequest<{
        mail?: string;
        userPrincipalName?: string;
      }>("/me");
      return data.mail || data.userPrincipalName || "";
    } catch (error) {
      logService.error("Failed to get user email", "OutlookFetch", { error });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "getUserEmail" },
      });
      throw error;
    }
  }

  /**
   * Get folders/mailboxes
   * @returns Array of mail folders
   */
  async getFolders(): Promise<any[]> {
    try {
      const data =
        await this._graphRequest<GraphApiResponse<any>>("/me/mailFolders");
      return data.value || [];
    } catch (error) {
      logService.error("Failed to get folders", "OutlookFetch", { error });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "getFolders" },
      });
      throw error;
    }
  }

  /**
   * Well-known folder display names to exclude from sync (TASK-2046)
   * Compared case-insensitively against folder displayName.
   */
  private static readonly EXCLUDED_FOLDER_NAMES = [
    "junkemail",
    "junk email",
    "deleteditems",
    "deleted items",
    "drafts",
    "outbox",
    "conflicts",
    "sync issues",
    "conversation history",
  ];

  /**
   * Well-known folder IDs to exclude from sync (TASK-2046)
   * Graph API also provides well-known folder names that can be used as IDs.
   */
  private static readonly EXCLUDED_WELL_KNOWN_IDS = [
    "junkemail",
    "deleteditems",
    "drafts",
    "outbox",
  ];

  /**
   * Discover all syncable mail folders including child folders (TASK-2046)
   *
   * Uses the Graph API mailFolders endpoint and recursively discovers
   * child folders. Filters out excluded system folders.
   *
   * @param parentId - Optional parent folder ID for recursive discovery
   * @param maxDepth - Maximum recursion depth (default 5)
   * @returns Array of syncable folders with id and displayName
   */
  async discoverFolders(
    parentId?: string,
    maxDepth: number = 5
  ): Promise<Array<{ id: string; displayName: string; parentFolderId?: string }>> {
    try {
      if (!this.accessToken) {
        throw new Error("Outlook API not initialized. Call initialize() first.");
      }

      if (maxDepth <= 0) {
        logService.debug("Max folder depth reached, stopping recursion", "OutlookFetch");
        return [];
      }

      const endpoint = parentId
        ? `/me/mailFolders/${parentId}/childFolders?$select=id,displayName,parentFolderId,childFolderCount`
        : `/me/mailFolders?$select=id,displayName,parentFolderId,childFolderCount&$top=100`;

      const data = await this._graphRequest<GraphApiResponse<{
        id: string;
        displayName: string;
        parentFolderId?: string;
        childFolderCount?: number;
      }>>(endpoint);

      const folders = data.value || [];
      const allFolders: Array<{ id: string; displayName: string; parentFolderId?: string }> = [];

      for (const folder of folders) {
        // Filter out excluded folders by display name
        const normalizedName = (folder.displayName || "").toLowerCase();
        if (OutlookFetchService.EXCLUDED_FOLDER_NAMES.includes(normalizedName)) {
          logService.debug(
            `Excluding folder: "${folder.displayName}"`,
            "OutlookFetch"
          );
          continue;
        }

        // Also check well-known IDs
        const normalizedId = (folder.id || "").toLowerCase();
        if (
          OutlookFetchService.EXCLUDED_WELL_KNOWN_IDS.some(
            (id) => normalizedId === id
          )
        ) {
          continue;
        }

        allFolders.push({
          id: folder.id,
          displayName: folder.displayName,
          parentFolderId: folder.parentFolderId,
        });

        // Recurse into child folders if any
        if (folder.childFolderCount && folder.childFolderCount > 0) {
          try {
            const childFolders = await this.discoverFolders(
              folder.id,
              maxDepth - 1
            );
            allFolders.push(...childFolders);
          } catch (childError) {
            logService.warn(
              `Failed to discover child folders for "${folder.displayName}"`,
              "OutlookFetch",
              {
                error:
                  childError instanceof Error
                    ? childError.message
                    : "Unknown error",
              }
            );
          }
        }
      }

      if (!parentId) {
        logService.info(
          `Discovered ${allFolders.length} syncable folders (from ${folders.length} top-level)`,
          "OutlookFetch"
        );
      }

      return allFolders;
    } catch (error) {
      logService.error("Failed to discover folders", "OutlookFetch", { error });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "discoverFolders" },
      });
      throw error;
    }
  }

  /**
   * Search emails from a specific mail folder (TASK-2046)
   *
   * Fetches messages from a single folder using the mailFolders/{id}/messages endpoint.
   *
   * @param folderId - The Outlook folder ID to fetch from
   * @param options - Search options (after, maxResults, onProgress)
   * @returns Array of parsed emails from the folder
   */
  async searchEmailsByFolder(
    folderId: string,
    options: {
      after?: Date | null;
      maxResults?: number;
      onProgress?: (progress: FetchProgress & { folder?: string }) => void;
    } = {}
  ): Promise<ParsedEmail[]> {
    try {
      if (!this.accessToken) {
        throw new Error("Outlook API not initialized. Call initialize() first.");
      }

      const { after = null, maxResults = 200, onProgress } = options;

      const selectFields =
        "$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,hasAttachments,body,bodyPreview,conversationId,inferenceClassification,parentFolderId,internetMessageId,internetMessageHeaders";

      const filters: string[] = [];
      if (after) {
        filters.push(`receivedDateTime ge ${after.toISOString()}`);
      }
      const filterString =
        filters.length > 0 ? `$filter=${filters.join(" and ")}` : "";
      const orderBy = "$orderby=receivedDateTime desc";

      const allMessages: GraphMessage[] = [];
      let skip = 0;
      let pageCount = 0;
      const pageSize = 100;

      do {
        pageCount++;
        const top = `$top=${pageSize}`;
        const skipParam = skip > 0 ? `$skip=${skip}` : "";

        const queryParams = [selectFields, orderBy, top, skipParam, filterString]
          .filter(Boolean)
          .join("&");

        const data = await this._graphRequest<GraphApiResponse<GraphMessage>>(
          `/me/mailFolders/${folderId}/messages?${queryParams}`
        );
        const messages = data.value || [];

        allMessages.push(...messages);
        skip += pageSize;

        if (onProgress) {
          onProgress({
            fetched: allMessages.length,
            total: allMessages.length,
            percentage: 0,
            hasEstimate: false,
            folder: folderId,
          });
        }

        if (messages.length < pageSize) break;
        if (allMessages.length >= maxResults) break;
      } while (true);

      const messagesToParse = maxResults
        ? allMessages.slice(0, maxResults)
        : allMessages;

      return messagesToParse.map((msg) => this._parseMessage(msg));
    } catch (error) {
      logService.error(
        `Failed to fetch emails for folder ${folderId}`,
        "OutlookFetch",
        { error }
      );
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "searchEmailsByFolder" },
      });
      throw error;
    }
  }

  /**
   * Discover all folders and fetch emails from each (TASK-2046)
   *
   * Orchestrates folder discovery and multi-folder fetch. Deduplicates
   * emails by message ID. Handles per-folder errors gracefully.
   *
   * @param options - Search options applied to each folder
   * @returns Deduplicated array of parsed emails from all folders
   */
  async searchAllFolders(
    options: {
      after?: Date | null;
      maxResults?: number;
      onProgress?: (progress: FetchProgress & { folder?: string; currentFolder?: string }) => void;
    } = {}
  ): Promise<ParsedEmail[]> {
    try {
      if (!this.accessToken) {
        throw new Error("Outlook API not initialized. Call initialize() first.");
      }

      const folders = await this.discoverFolders();
      logService.info(
        `Starting multi-folder fetch across ${folders.length} folders`,
        "OutlookFetch"
      );

      const seenMessageIds = new Set<string>();
      const allEmails: ParsedEmail[] = [];

      for (const folder of folders) {
        try {
          const emails = await this.searchEmailsByFolder(folder.id, {
            after: options.after,
            maxResults: options.maxResults,
            onProgress: options.onProgress
              ? (progress) => {
                  options.onProgress!({
                    ...progress,
                    currentFolder: folder.displayName,
                  });
                }
              : undefined,
          });

          // Deduplicate by message ID
          let newCount = 0;
          for (const email of emails) {
            if (!seenMessageIds.has(email.id)) {
              seenMessageIds.add(email.id);
              allEmails.push(email);
              newCount++;
            }
          }

          logService.debug(
            `Folder "${folder.displayName}": ${emails.length} messages, ${newCount} new`,
            "OutlookFetch"
          );
        } catch (folderError) {
          // Per-folder error isolation: skip this folder, continue with others
          logService.warn(
            `Failed to fetch emails for folder "${folder.displayName}" (${folder.id}), skipping`,
            "OutlookFetch",
            {
              error:
                folderError instanceof Error
                  ? folderError.message
                  : "Unknown error",
            }
          );
        }
      }

      logService.info(
        `Multi-folder fetch complete: ${allEmails.length} unique emails from ${folders.length} folders`,
        "OutlookFetch"
      );

      return allEmails;
    } catch (error) {
      logService.error(
        "Failed to search all folders",
        "OutlookFetch",
        { error }
      );
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "searchAllFolders" },
      });
      throw error;
    }
  }

  /**
   * Check emails for duplicates and populate duplicateOf field (TASK-919)
   *
   * Uses EmailDeduplicationService to detect duplicates by:
   * 1. Message-ID header (most reliable)
   * 2. Content hash (fallback)
   *
   * @param userId - User ID to scope the duplicate check
   * @param emails - Array of parsed emails to check
   * @returns Same emails with duplicateOf field populated where applicable
   */
  async checkDuplicates(
    userId: string,
    emails: ParsedEmail[]
  ): Promise<ParsedEmail[]> {
    return EmailDeduplicationService.checkDuplicates(userId, emails, {
      logLabel: "OutlookFetch",
      sentryTag: "outlook-fetch",
    });
  }

  /**
   * Fetch contacts from Outlook via Microsoft Graph API (TASK-1920)
   *
   * Checks scopes_granted before attempting fetch. If the token lacks
   * Contacts.Read scope, returns a reconnect-required error without
   * making API calls. Handles 403/Forbidden gracefully.
   *
   * @param userId - User ID to fetch contacts for
   * @returns FetchContactsResult with mapped contacts or error info
   */
  async fetchContacts(userId: string): Promise<FetchContactsResult> {
    try {
      if (!this.accessToken) {
        throw new Error(
          "Outlook API not initialized. Call initialize() first.",
        );
      }

      // Check scopes_granted before attempting fetch (TASK-1920)
      // Existing users may have tokens without Contacts.Read scope
      const tokenRecord = await databaseService.getOAuthToken(
        userId,
        "microsoft",
        "mailbox",
      );

      if (tokenRecord?.scopes_granted) {
        const grantedScopes =
          typeof tokenRecord.scopes_granted === "string"
            ? tokenRecord.scopes_granted
            : String(tokenRecord.scopes_granted);

        if (
          !grantedScopes.toLowerCase().includes("contacts.read")
        ) {
          logService.info(
            "Contacts.Read scope not granted. User needs to reconnect mailbox.",
            "OutlookFetch",
          );
          return {
            success: false,
            contacts: [],
            error:
              "Contacts.Read permission not granted. Please disconnect and reconnect your Microsoft mailbox to grant contact access.",
            reconnectRequired: true,
          };
        }
      }

      logService.info("Fetching Outlook contacts", "OutlookFetch", { userId });

      const allContacts: GraphContact[] = [];
      const selectFields =
        "$select=id,displayName,emailAddresses,mobilePhone,homePhones,businessPhones,companyName";
      let nextLink: string | null = null;
      let pageCount = 0;

      // First request
      let endpoint = `/me/contacts?$top=250&${selectFields}`;

      do {
        pageCount++;
        logService.debug(
          `Fetching contacts page ${pageCount}`,
          "OutlookFetch",
        );

        let data: { value: GraphContact[]; "@odata.nextLink"?: string };

        if (nextLink) {
          // For pagination, use the full nextLink URL directly
          // _graphRequest prepends graphApiUrl, so strip it from nextLink
          const relativePath = nextLink.replace(this.graphApiUrl, "");
          data = await this._graphRequest<typeof data>(relativePath);
        } else {
          data = await this._graphRequest<typeof data>(endpoint);
        }

        const contacts = data.value || [];
        logService.debug(
          `Page ${pageCount}: Found ${contacts.length} contacts`,
          "OutlookFetch",
        );

        allContacts.push(...contacts);
        nextLink = data["@odata.nextLink"] || null;
      } while (nextLink);

      logService.info(
        `Total contacts fetched: ${allContacts.length}`,
        "OutlookFetch",
      );

      // Map Graph API contacts to OutlookContact format
      const mappedContacts: OutlookContact[] = allContacts.map((contact) =>
        this._mapGraphContact(contact),
      );

      return {
        success: true,
        contacts: mappedContacts,
      };
    } catch (error: unknown) {
      // Handle 403 Forbidden — token lacks Contacts.Read scope
      const axiosErr = error as { response?: { status?: number } };
      if (axiosErr.response?.status === 403) {
        logService.info(
          "403 Forbidden fetching contacts — token lacks Contacts.Read scope",
          "OutlookFetch",
        );
        return {
          success: false,
          contacts: [],
          error:
            "Access denied to contacts. Please disconnect and reconnect your Microsoft mailbox to grant contact access.",
          reconnectRequired: true,
        };
      }

      logService.error("Failed to fetch contacts", "OutlookFetch", { error });
      Sentry.captureException(error, {
        tags: { service: "outlook-fetch", operation: "fetchContacts" },
      });
      throw error;
    }
  }

  /**
   * Map a Microsoft Graph contact to OutlookContact format (TASK-1920)
   * @private
   */
  private _mapGraphContact(contact: GraphContact): OutlookContact {
    // Extract email addresses
    const emails: string[] = [];
    if (contact.emailAddresses) {
      for (const emailEntry of contact.emailAddresses) {
        if (emailEntry.address) {
          emails.push(emailEntry.address);
        }
      }
    }

    // Flatten all phone fields into a single array
    const phones: string[] = [];
    if (contact.mobilePhone) {
      phones.push(contact.mobilePhone);
    }
    if (contact.homePhones) {
      for (const phone of contact.homePhones) {
        if (phone) {
          phones.push(phone);
        }
      }
    }
    if (contact.businessPhones) {
      for (const phone of contact.businessPhones) {
        if (phone) {
          phones.push(phone);
        }
      }
    }

    return {
      external_record_id: contact.id,
      name: contact.displayName || null,
      emails,
      phones,
      company: contact.companyName || null,
    };
  }
}

export default new OutlookFetchService();
