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
 * BACKLOG-1831: Microsoft Graph per-folder message delta response.
 *
 * A delta round paginates via @odata.nextLink and terminates with an
 * @odata.deltaLink (the cursor to resume the NEXT round). Deleted messages
 * arrive as entries carrying an `@removed` annotation — the shadow engine is
 * ADDITIVE-ONLY and skips them entirely.
 */
interface GraphDeltaMessage extends GraphMessage {
  "@removed"?: { reason?: string };
}
interface GraphDeltaResponse {
  value: GraphDeltaMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/**
 * BACKLOG-1831: typed signal that a stored delta token has expired (HTTP 410
 * Gone). The shadow orchestrator catches this, clears that folder's cursor, and
 * starts a fresh enumeration next cycle — no full re-sync machinery is built.
 */
export class DeltaTokenExpiredError extends Error {
  constructor(public readonly folderId: string) {
    super(`Outlook delta token expired (410 Gone) for folder ${folderId}`);
    this.name = "DeltaTokenExpiredError";
  }
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
  /**
   * BACKLOG-1802: Provenance of this row for the writer's ingest_source column.
   * - 'filter': sourced from a transactionally-consistent $filter query
   *   (from/emailAddress/address eq + server-side date bounds, or a folder sweep).
   * - 'search_validated': sourced from a KQL $search (to:/cc: recipient match or
   *   free-text body) and existence-confirmed server-side before return.
   * The default is 'filter'; $search paths override it explicitly.
   */
  ingestSource?: "filter" | "search_validated";
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
 * BACKLOG-1802 / BACKLOG-1753: hard cap on @odata.nextLink follow-through.
 *
 * Graph paginates $search and $filter results via @odata.nextLink. The old code
 * never followed it for $search, silently truncating multi-page results to a
 * single page (the mechanism behind the fresh-install 18/69 slice). We now follow
 * every page, but bound the walk so a runaway query cannot loop forever. Hitting
 * this cap is an AUDIT-COMPLETENESS event — it MUST be logged loudly (never a
 * silent break), per the founder's audit-completeness stance.
 */
const MAX_GRAPH_PAGES = 10;

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
            // BACKLOG-1802 (design §3): request immutable message IDs on EVERY
            // Graph call. Immutable IDs do not change when a message is moved or
            // archived, so a later existence/reconcile check ($batch by id) cannot
            // false-positive a 404 for a message that simply moved folders. Callers
            // may still override via extraHeaders.
            Prefer: 'IdType="ImmutableId"',
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

      const pageSize = 100; // Fetch 100 per page
      let allMessages: GraphMessage[] = [];

      logService.info("Outlook search starting", "OutlookFetch", {
        initialSkip,
        maxResults: maxResults || "unlimited",
        hasSearch: !!searchParam,
        hasFilter: !!filterString,
      });

      if (searchParam) {
        // BACKLOG-1802 / BACKLOG-1753: $search cannot be combined with $skip
        // ("$skip causes 400 with $search"), so the old loop refetched page 1
        // forever / truncated to a single page — the mechanism behind the
        // fresh-install 18/69 slice. Follow @odata.nextLink through every page
        // instead (helper caps at MAX_GRAPH_PAGES and logs truncation loudly).
        const top = `$top=${pageSize}`;
        const initialParams = [selectFields, top, searchParam].filter(Boolean).join("&");
        allMessages = await this._paginateGraphMessages(
          `/me/messages?${initialParams}`,
          `searchEmails $search`,
          maxResults,
          onProgress
            ? (accumulated) => {
                const currentTotal = hasEstimate ? targetTotal : accumulated;
                const percentage = hasEstimate
                  ? Math.min(100, Math.round((accumulated / targetTotal) * 100))
                  : 0;
                onProgress({ fetched: accumulated, total: currentTotal, estimatedTotal, percentage, hasEstimate });
              }
            : undefined,
        );
      } else {
        // $filter/date path: $skip pagination is valid and $orderby is available.
        // Bounded by the date filter; guarded by MAX_GRAPH_PAGES so a runaway
        // window still terminates with loud telemetry rather than silently.
        let skip = initialSkip;
        let pageCount = 0;
        let hitPageCap = false;
        do {
          pageCount++;
          const top = `$top=${pageSize}`;
          const skipParam = skip > 0 ? `$skip=${skip}` : "";
          const queryParams = [selectFields, orderBy, top, skipParam, filterString]
            .filter(Boolean)
            .join("&");

          const data = await this._graphRequest<GraphApiResponse<GraphMessage>>(
            `/me/messages?${queryParams}`,
          );
          const messages = data.value || [];
          allMessages.push(...messages);
          skip += pageSize;

          if (onProgress) {
            const fetched = allMessages.length;
            const currentTotal = hasEstimate ? targetTotal : fetched;
            const percentage = hasEstimate
              ? Math.min(100, Math.round((fetched / targetTotal) * 100))
              : 0;
            onProgress({ fetched, total: currentTotal, estimatedTotal, percentage, hasEstimate });
          }

          if (messages.length < pageSize) break;
          if (maxResults && allMessages.length >= maxResults) break;
          if (pageCount >= MAX_GRAPH_PAGES) { hitPageCap = true; break; }
        } while (true);

        if (hitPageCap) {
          logService.warn(
            `[BACKLOG-1802] Outlook $filter pagination hit the ${MAX_GRAPH_PAGES}-page cap (${allMessages.length} messages) — more may exist in this window.`,
            "OutlookFetch",
          );
          Sentry.captureMessage("Graph pagination truncated: searchEmails $filter", {
            level: "warning",
            tags: { component: "email_sync", provider: "outlook", event: "pagination_truncated", reason: "page_cap" },
            extra: { messagesFetched: allMessages.length, maxPages: MAX_GRAPH_PAGES },
          });
        }
      }

      logService.info(
        `Total messages found: ${allMessages.length}`,
        "OutlookFetch",
      );

      // Parse messages (apply maxResults cap only if explicitly set).
      // BACKLOG-1802: $filter results are transactionally consistent → 'filter';
      // $search results are stale-index-prone → 'search_validated' (validated below).
      const messagesToParse = maxResults ? allMessages.slice(0, maxResults) : allMessages;
      const ingestSource: "filter" | "search_validated" = searchParam ? "search_validated" : "filter";
      let parsed = messagesToParse.map((msg) => this._parseMessage(msg, ingestSource));

      // When $search is used, dates couldn't be in $filter — filter client-side
      if (searchParam && (clientDateFilter.after || clientDateFilter.before)) {
        parsed = parsed.filter((email) => {
          if (clientDateFilter.after && email.date < clientDateFilter.after) return false;
          if (clientDateFilter.before && email.date > clientDateFilter.before) return false;
          return true;
        });
      }

      // BACKLOG-1802 (design §3/§4): a KQL $search can surface stale index hits.
      // Existence-validate server-side and drop anything the server no longer has,
      // so a $search-sourced row is never stored as a ghost.
      if (searchParam && parsed.length > 0) {
        const live = await this.validateMessageIdsExist(parsed.map((e) => e.id));
        const before = parsed.length;
        parsed = parsed.filter((e) => live.has(e.id));
        if (parsed.length < before) {
          logService.info(
            `[BACKLOG-1802] Dropped ${before - parsed.length} stale $search hit(s) failing existence validation`,
            "OutlookFetch",
          );
        }
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
   * Search sent items for emails addressed TO or CC'ing specific contacts.
   *
   * BACKLOG-1802 (design §4, R1): Graph does NOT support $filter on
   * toRecipients/ccRecipients, so the recipient side MUST use KQL $search. The
   * old implementation had two audit-completeness holes:
   *   1. No pagination — a single $top page silently truncated large results.
   *   2. Only `to:` — cc-only recipients were invisible.
   * Both are fixed: `to:` OR `cc:` KQL, full @odata.nextLink follow-through, and
   * server-side existence validation (KQL can return stale index hits). Results
   * are tagged `search_validated`.
   *
   * $search cannot combine with $filter, so date bounds are applied client-side.
   *
   * @param contactEmails - Contact email addresses to search for
   * @param maxResults - Accumulation cap per contact email (safety valve)
   * @param after - Optional lower date bound (client-side)
   * @param before - Optional upper date bound (client-side) — BACKLOG-1802 backfill windowing
   */
  async searchSentEmailsToContacts(
    contactEmails: string[],
    maxResults: number = 50,
    after?: Date | null,
    before?: Date | null,
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
        // BACKLOG-1802: match both To and Cc recipients (cc-only was invisible).
        const searchQuery = `$search="to:${email} OR cc:${email}"`;
        const top = `$top=100`;
        const queryParams = [selectFields, top, searchQuery]
          .filter(Boolean)
          .join("&");

        // BACKLOG-1802: follow @odata.nextLink through every page (was a single
        // truncated page). Helper caps at MAX_GRAPH_PAGES with loud telemetry.
        const messages = await this._paginateGraphMessages(
          `/me/mailFolders/sentItems/messages?${queryParams}`,
          `searchSentEmailsToContacts to/cc:${email}`,
          maxResults,
        );

        logService.info(
          `Sent items search for "${email}": found ${messages.length}`,
          "OutlookFetch",
        );

        for (const msg of messages) {
          if (!seenIds.has(msg.id)) {
            seenIds.add(msg.id);
            // BACKLOG-1802: tag provenance as search_validated (validated below).
            const parsed = this._parseMessage(msg, "search_validated");
            // Client-side date bounds ($search cannot combine with $filter).
            if (after && parsed.date < after) continue;
            if (before && parsed.date > before) continue;
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

    // BACKLOG-1802 (design §3/§4): existence-validate the KQL hits and drop any
    // the server no longer has, so a $search-sourced sent item is never a ghost.
    if (allParsed.length === 0) return allParsed;
    const live = await this.validateMessageIdsExist(allParsed.map((e) => e.id));
    const validated = allParsed.filter((e) => live.has(e.id));
    if (validated.length < allParsed.length) {
      logService.info(
        `[BACKLOG-1802] Dropped ${allParsed.length - validated.length} stale sent-items $search hit(s) failing existence validation`,
        "OutlookFetch",
      );
    }
    return validated;
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
  /**
   * BACKLOG-1802 / BACKLOG-1753: follow @odata.nextLink from an initial Graph
   * `/me/messages` (or folder/sentItems) endpoint, accumulating every page up to
   * MAX_GRAPH_PAGES. Graph returns @odata.nextLink for BOTH $search and $filter
   * results; the old $search path never followed it and truncated to one page.
   *
   * A remaining nextLink at the page cap (or at a caller maxResults cap) is a
   * truncation event: logged LOUDLY + Sentry-breadcrumbed (never a silent break),
   * per the founder's audit-completeness stance.
   *
   * @param initialEndpoint path relative to the Graph root (leading "/")
   * @param context human label for telemetry
   * @param maxResults optional accumulation cap (safety valve)
   * @param onPage optional per-page progress callback
   */
  private async _paginateGraphMessages(
    initialEndpoint: string,
    context: string,
    maxResults?: number,
    onPage?: (accumulated: number) => void,
  ): Promise<GraphMessage[]> {
    const all: GraphMessage[] = [];
    let endpoint: string | null = initialEndpoint;
    let pageCount = 0;
    let truncatedReason: "page_cap" | "max_results" | null = null;

    while (endpoint) {
      pageCount++;
      const currentEndpoint: string = endpoint;
      const data: GraphApiResponse<GraphMessage> =
        await this._graphRequest<GraphApiResponse<GraphMessage>>(currentEndpoint);
      const messages = data.value || [];
      all.push(...messages);
      onPage?.(all.length);

      const next: string | undefined = data["@odata.nextLink"];

      if (maxResults && all.length >= maxResults) {
        if (next) truncatedReason = "max_results";
        break;
      }
      if (!next) break;
      if (pageCount >= MAX_GRAPH_PAGES) {
        truncatedReason = "page_cap";
        break;
      }
      // Graph returns an ABSOLUTE nextLink; strip the root so _graphRequest can
      // re-prepend it (and re-attach auth + the ImmutableId Prefer header).
      endpoint = next.startsWith(this.graphApiUrl)
        ? next.slice(this.graphApiUrl.length)
        : next;
    }

    if (truncatedReason) {
      logService.warn(
        `[BACKLOG-1802] Graph pagination TRUNCATED (${truncatedReason}) for ${context}: stopped after ${pageCount} page(s) / ${all.length} message(s) with more results still available on the server. Audit completeness may be affected.`,
        "OutlookFetch",
      );
      Sentry.captureMessage(`Graph pagination truncated: ${context}`, {
        level: "warning",
        tags: {
          component: "email_sync",
          provider: "outlook",
          event: "pagination_truncated",
          reason: truncatedReason,
        },
        extra: {
          context,
          pageCount,
          messagesFetched: all.length,
          maxPages: MAX_GRAPH_PAGES,
          maxResults: maxResults ?? null,
        },
      });
    }

    return all;
  }

  /**
   * BACKLOG-1831: additive-only SHADOW-mode delta fetch for ONE mail folder.
   *
   * Graph message delta is PER-FOLDER (there is no whole-mailbox message delta):
   *   GET /me/mailFolders/{folderId}/messages/delta
   *
   * - First call (no stored deltaLink): starts at the folder's delta endpoint with
   *   the SAME $select field list the rest of the service uses. Graph message
   *   delta has limited $select support; if the initial call is rejected as
   *   BadRequest(400) for the field list we retry ONCE without $select and let
   *   Graph return its default projection (still enough for _parseMessage — a
   *   missing internetMessageHeaders just means messageIdHeader falls back to
   *   null, which is fine for additive dedup). Landed behavior: $select included,
   *   automatic bare-delta fallback on 400.
   * - Subsequent calls: the caller passes the stored @odata.deltaLink; we strip
   *   the Graph root (same trick as _paginateGraphMessages) and resume.
   * - Pages within a round are followed via @odata.nextLink; the round finishes
   *   when @odata.deltaLink arrives (returned as the new cursor).
   * - ADDITIVE-ONLY: `@removed` deletion entries are skipped entirely and only
   *   counted (removedSkipped) for the shadow log line — no deletes, no updates.
   * - HTTP 410 Gone (expired token) throws DeltaTokenExpiredError so the caller
   *   can reset that folder's cursor.
   *
   * Page cap: a delta-specific MAX_DELTA_PAGES (50 → up to 5000 msgs/round),
   * higher than the $filter MAX_GRAPH_PAGES=10, because the FIRST-EVER round for a
   * folder enumerates the entire folder. A round that hits the cap returns no
   * deltaLink (the caller keeps the old cursor and resumes next cycle) and reports
   * the truncation loudly, matching the founder's audit-completeness stance.
   */
  async fetchDeltaEmails(
    folderId: string,
    deltaLink: string | null,
    onPage?: (accumulated: number) => void,
  ): Promise<{ emails: ParsedEmail[]; deltaLink: string | null; removedSkipped: number }> {
    if (!this.accessToken) {
      throw new Error("Outlook API not initialized. Call initialize() first.");
    }

    const DELTA_SELECT =
      "$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,hasAttachments,body,bodyPreview,conversationId,inferenceClassification,parentFolderId,internetMessageId,internetMessageHeaders";
    const MAX_DELTA_PAGES = 50;

    const stripRoot = (url: string): string =>
      url.startsWith(this.graphApiUrl) ? url.slice(this.graphApiUrl.length) : url;

    let endpoint: string = deltaLink
      ? stripRoot(deltaLink)
      : `/me/mailFolders/${folderId}/messages/delta?${DELTA_SELECT}`;

    const emails: ParsedEmail[] = [];
    let removedSkipped = 0;
    let nextDeltaLink: string | null = null;
    let pageCount = 0;
    let selectFallbackTried = false;

    for (;;) {
      pageCount++;
      let data: GraphDeltaResponse;
      try {
        data = await this._graphRequest<GraphDeltaResponse>(endpoint);
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        // Expired delta token — surface a typed reset signal (no re-sync machinery).
        if (status === 410) {
          throw new DeltaTokenExpiredError(folderId);
        }
        // Graceful $select fallback for the initial call only.
        if (
          status === 400 &&
          !deltaLink &&
          !selectFallbackTried &&
          endpoint.includes("$select=")
        ) {
          selectFallbackTried = true;
          pageCount--; // this attempt didn't land a page
          endpoint = `/me/mailFolders/${folderId}/messages/delta`;
          logService.info(
            `[BACKLOG-1831] Delta $select rejected for folder ${folderId}; retrying without $select`,
            "OutlookFetch",
          );
          continue;
        }
        throw error;
      }

      const entries = data.value || [];
      for (const entry of entries) {
        // ADDITIVE-ONLY (BACKLOG-1831 §2): never process @removed deletions.
        if (entry["@removed"]) {
          removedSkipped++;
          continue;
        }
        emails.push(this._parseMessage(entry));
      }
      onPage?.(emails.length);

      const roundDeltaLink = data["@odata.deltaLink"];
      if (roundDeltaLink) {
        nextDeltaLink = roundDeltaLink; // round complete — this is the new cursor
        break;
      }

      const next = data["@odata.nextLink"];
      if (!next) break; // defensive: no deltaLink and no nextLink → stop
      if (pageCount >= MAX_DELTA_PAGES) {
        // Round did NOT finish. Return no deltaLink so the caller keeps the old
        // cursor and resumes next cycle. Report LOUDLY (never a silent break).
        logService.warn(
          `[BACKLOG-1831] Delta round TRUNCATED at page cap (${MAX_DELTA_PAGES}) for folder ${folderId}: ${emails.length} message(s) so far with more still available. Resuming next cycle.`,
          "OutlookFetch",
        );
        Sentry.captureMessage(`Shadow delta round truncated: folder ${folderId}`, {
          level: "warning",
          tags: {
            component: "email_sync",
            provider: "outlook",
            event: "shadow_delta_truncated",
          },
          extra: { folderId, pageCount, messagesFetched: emails.length, maxPages: MAX_DELTA_PAGES },
        });
        break;
      }
      endpoint = stripRoot(next);
    }

    return { emails, deltaLink: nextDeltaLink, removedSkipped };
  }

  /**
   * BACKLOG-1802 (design §3/§4): existence-validate a set of provider message IDs
   * against the server with a single $batch of GET /messages/{id}?$select=id
   * requests (20 per batch, Graph's limit). KQL $search can return stale index
   * hits for messages that no longer exist; anything not confirmed live is dropped
   * so a $search-sourced row is never stored as a ghost.
   *
   * With the ImmutableId Prefer header a moved/archived message keeps its id and
   * still resolves 200 — only a genuinely-gone message 404s.
   *
   * @returns the subset of ids the server confirms still exist.
   */
  async validateMessageIdsExist(ids: string[]): Promise<Set<string>> {
    const live = new Set<string>();
    if (ids.length === 0) return live;

    const BATCH_SIZE = 20; // Graph JSON $batch hard limit
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const chunk = ids.slice(i, i + BATCH_SIZE);
      const requests = chunk.map((id, idx) => ({
        id: String(idx),
        method: "GET",
        url: `/me/messages/${encodeURIComponent(id)}?$select=id`,
      }));
      try {
        const resp = await this._graphRequest<{
          responses?: Array<{ id: string; status: number }>;
        }>("/$batch", "POST", { requests });

        const responses = resp?.responses;
        if (!Array.isArray(responses)) {
          // Malformed/ambiguous batch response: fail OPEN (keep the chunk).
          // Never drop evidence unless the server DEFINITIVELY says it's gone.
          for (const id of chunk) live.add(id);
        } else {
          const statusByIdx = new Map<number, number>();
          for (const r of responses) statusByIdx.set(Number(r.id), r.status);
          chunk.forEach((id, idx) => {
            const status = statusByIdx.get(idx);
            // Drop ONLY on a definitive 404/410 (message gone). Keep on 200, on an
            // unexpected/5xx status, and on a missing response — audit-safe.
            const gone = status === 404 || status === 410;
            if (!gone) live.add(id);
          });
        }
      } catch (batchError) {
        // Fail OPEN on a batch transport error: existence validation is a
        // precision filter, not a completeness gate — dropping everything on a
        // transient 500 would HURT completeness. Keep the chunk and let the
        // downstream reconcile sweep (T4) catch true ghosts.
        logService.warn(
          "[BACKLOG-1802] $batch existence validation failed; keeping unvalidated ids for this chunk",
          "OutlookFetch",
          { error: batchError instanceof Error ? batchError.message : "Unknown", chunkSize: chunk.length },
        );
        for (const id of chunk) live.add(id);
      }
    }

    return live;
  }

  private _parseMessage(
    message: GraphMessage,
    ingestSource: "filter" | "search_validated" = "filter",
  ): ParsedEmail {
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
      // BACKLOG-1802: provenance for the writer's ingest_source column.
      ingestSource,
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
      // BACKLOG-1802: upper date bound so backfill/forward deltas fetch only the
      // missing window instead of re-sweeping the whole folder every trigger.
      before?: Date | null;
      maxResults?: number;
      onProgress?: (progress: FetchProgress & { folder?: string }) => void;
    } = {}
  ): Promise<ParsedEmail[]> {
    try {
      if (!this.accessToken) {
        throw new Error("Outlook API not initialized. Call initialize() first.");
      }

      const { after = null, before = null, maxResults = 200, onProgress } = options;

      const selectFields =
        "$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,hasAttachments,body,bodyPreview,conversationId,inferenceClassification,parentFolderId,internetMessageId,internetMessageHeaders";

      const filters: string[] = [];
      if (after) {
        filters.push(`receivedDateTime ge ${after.toISOString()}`);
      }
      if (before) {
        filters.push(`receivedDateTime le ${before.toISOString()}`);
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
      // BACKLOG-1802: upper date bound propagated to every folder for delta windowing.
      before?: Date | null;
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
            before: options.before,
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
