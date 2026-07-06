// ============================================
// EMAIL LINKING IPC HANDLERS
// Handles: get-unlinked-messages, get-unlinked-emails, link-emails,
//          get-message-contacts, get-messages-by-contact, link-messages, unlink-messages
// Extracted from emailSyncHandlers.ts (TASK-2065)
// ============================================

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import transactionService from "../services/transactionService";
import logService from "../services/logService";
import { createEmail, getEmailById, getEmailByExternalId, getCachedEmails } from "../services/db/emailDbService";
import { createCommunication, removeIgnoredCommunication } from "../services/db/communicationDbService";
import { dbAll } from "../services/db/core/dbConnection";
import gmailFetchService from "../services/gmailFetchService";
import outlookFetchService from "../services/outlookFetchService";
import emailSyncService from "../services/emailSyncService";
import { wrapHandler } from "../utils/wrapHandler";
import type { TransactionResponse } from "../types/handlerTypes";
import {
  ValidationError,
  validateUserId,
  validateTransactionId,
} from "../utils/validation";

/**
 * Register email linking/unlinking IPC handlers
 */
export function registerEmailLinkingHandlers(): void {
  // Get unlinked messages (not attached to any transaction)
  ipcMain.handle(
    "transactions:get-unlinked-messages",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Getting unlinked messages", "Transactions", { userId });

      // Validate input
      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      const messages = await transactionService.getUnlinkedMessages(validatedUserId);

      return {
        success: true,
        messages,
      };
    }, { module: "Transactions" }),
  );

  // Get unlinked emails - fetches from email provider (Gmail/Outlook) and stores locally
  // TASK-2067: Routes through emailSyncService.searchProviderEmails() to store fetched emails
  // TASK-1993: Server-side search   TASK-1998: body preview fix   BACKLOG-712: contact email filter
  ipcMain.handle(
    "transactions:get-unlinked-emails",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
      options?: {
        query?: string;
        after?: string;   // ISO date string
        before?: string;  // ISO date string
        maxResults?: number;
        skip?: number;    // BACKLOG-711: offset for pagination (skip already-fetched results)
        transactionId?: string; // BACKLOG-712: filter by transaction contact emails
        _skipCache?: boolean; // BACKLOG-1559: force provider fetch (background refresh after stale cache)
      },
    ): Promise<TransactionResponse> => {
      const effectiveMaxResults = Math.min(options?.maxResults || 100, 500);
      logService.info("Fetching emails from provider", "Transactions", {
        userId,
        query: options?.query || "",
        after: options?.after || null,
        before: options?.before || null,
        maxResults: effectiveMaxResults,
        skip: options?.skip || 0,
        transactionId: options?.transactionId || null,
      });

      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      // Validate transactionId if provided
      let validatedTxnId: string | undefined;
      if (options?.transactionId) {
        const txnId = validateTransactionId(options.transactionId);
        if (txnId) validatedTxnId = txnId;
      }

      // BACKLOG-1559: Try local cache first (no pagination skip = not a "load more" request).
      // Always serve from cache if data exists — instant response.
      // Modal always does a background refresh to check for new emails.
      // Skip cache if _skipCache flag is set (the background refresh call).
      if (!options?.skip && !options?._skipCache) {
        const cachedEmails = await getCachedEmails(validatedUserId, {
          query: options?.query || undefined,
          after: options?.after ? new Date(options.after) : null,
          before: options?.before ? new Date(options.before) : null,
          maxResults: effectiveMaxResults,
        });
        if (cachedEmails.length > 0) {
          logService.info("Returning cached emails", "Transactions", {
            count: cachedEmails.length,
            query: options?.query || "(none)",
          });
          return {
            success: true,
            emails: cachedEmails,
            fromCache: true,
          };
        }
      }

      // TASK-2067: Fall back to provider API if cache is empty or user is searching/paginating
      const result = await emailSyncService.searchProviderEmails({
        userId: validatedUserId,
        searchParams: {
          query: options?.query || "",
          after: options?.after ? new Date(options.after) : null,
          before: options?.before ? new Date(options.before) : null,
          maxResults: effectiveMaxResults,
          skip: options?.skip || 0,
        },
        transactionId: validatedTxnId,
      });

      if (result.noProviderConnected) {
        return {
          success: false,
          error: "No email account connected. Please connect Gmail or Outlook in Settings.",
        };
      }

      return {
        success: true,
        emails: result.emails,
      };
    }, { module: "Transactions" }),
  );

  // Link emails to a transaction - fetches full email from provider and saves to database
  ipcMain.handle(
    "transactions:link-emails",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      emailIds: string[],
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Linking emails to transaction", "Transactions", {
        emailCount: emailIds?.length || 0,
        transactionId,
      });

      // Validate transaction ID
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      // Validate email IDs
      if (!Array.isArray(emailIds) || emailIds.length === 0) {
        throw new ValidationError(
          "Email IDs must be a non-empty array",
          "emailIds",
        );
      }

      // Get transaction to get user_id
      const transaction = await transactionService.getTransactionDetails(validatedTransactionId);
      if (!transaction) {
        throw new ValidationError("Transaction not found", "transactionId");
      }

      // BACKLOG-1579 Phase 2: Classify email IDs as local UUIDs or provider-prefixed.
      // UUIDs are looked up directly in the emails table; provider-prefixed IDs
      // fall back to the legacy fetch-from-provider path for backward compatibility.
      const uuidIds: string[] = [];
      const gmailIds: string[] = [];
      const outlookIds: string[] = [];
      for (const emailId of emailIds) {
        if (!emailId || typeof emailId !== "string") continue;
        if (emailId.startsWith("gmail:")) {
          gmailIds.push(emailId.replace("gmail:", ""));
        } else if (emailId.startsWith("outlook:")) {
          outlookIds.push(emailId.replace("outlook:", ""));
        } else {
          // Treat as local UUID
          uuidIds.push(emailId);
        }
      }

      let linkedCount = 0;

      // BACKLOG-1579 Phase 2: Link emails by local UUID (primary path)
      for (const localId of uuidIds) {
        try {
          let emailRecord = await getEmailById(localId);

          if (!emailRecord) {
            logService.warn(`Email UUID not found in DB, skipping: ${localId}`, "Transactions");
            continue;
          }

          // If body is missing, fetch from provider using source + external_id
          if (!emailRecord.body_html && !emailRecord.body_plain && emailRecord.source && emailRecord.external_id) {
            try {
              if (emailRecord.source === "gmail") {
                const isReady = await gmailFetchService.initialize(transaction.user_id);
                if (isReady) {
                  const fullEmail = await gmailFetchService.getEmailById(emailRecord.external_id);
                  emailRecord = {
                    ...emailRecord,
                    body_html: fullEmail.body,
                    body_plain: fullEmail.bodyPlain,
                    subject: fullEmail.subject ?? emailRecord.subject,
                    sender: fullEmail.from ?? emailRecord.sender,
                    recipients: fullEmail.to ?? emailRecord.recipients,
                    has_attachments: fullEmail.hasAttachments || emailRecord.has_attachments,
                  };
                }
              } else if (emailRecord.source === "outlook") {
                const isReady = await outlookFetchService.initialize(transaction.user_id);
                if (isReady) {
                  const fullEmail = await outlookFetchService.getEmailById(emailRecord.external_id);
                  emailRecord = {
                    ...emailRecord,
                    body_html: fullEmail.body,
                    body_plain: fullEmail.bodyPlain,
                    subject: fullEmail.subject ?? emailRecord.subject,
                    sender: fullEmail.from ?? emailRecord.sender,
                    recipients: fullEmail.to ?? emailRecord.recipients,
                    has_attachments: fullEmail.hasAttachments || emailRecord.has_attachments,
                  };
                }
              }
            } catch (fetchError) {
              logService.warn(`Failed to fetch body for email UUID ${localId}`, "Transactions", {
                error: fetchError instanceof Error ? fetchError.message : "Unknown",
                source: emailRecord.source,
                external_id: emailRecord.external_id,
              });
              // Continue linking even without body — the record still exists
            }
          }

          // Create junction link in communications table.
          // BACKLOG-1718 (R3): pass thread_id so unlinkCommunication can expand
          // the deletion to all sibling emails in the same thread.
          await createCommunication({
            user_id: transaction.user_id,
            transaction_id: validatedTransactionId,
            email_id: emailRecord.id,
            thread_id: emailRecord.thread_id || undefined,
            communication_type: "email",
            link_source: "manual",
            link_confidence: 1.0,
            has_attachments: emailRecord.has_attachments || false,
            is_false_positive: false,
          });
          linkedCount++;
        } catch (emailError) {
          logService.warn(`Failed to link email UUID ${localId}`, "Transactions", {
            error: emailError instanceof Error ? emailError.message : "Unknown",
          });
        }
      }

      // Legacy fallback: Fetch and save Gmail emails (provider-prefixed IDs)
      if (gmailIds.length > 0) {
        try {
          const isReady = await gmailFetchService.initialize(transaction.user_id);
          if (isReady) {
            for (const messageId of gmailIds) {
              try {
                const email = await gmailFetchService.getEmailById(messageId);

                // BACKLOG-506: Check if email already exists (dedup by external_id)
                let emailRecord = await getEmailByExternalId(transaction.user_id, messageId);

                if (!emailRecord) {
                  // Create email in emails table (content store)
                  // BACKLOG-1722: pass `participants` so the junction is
                  // populated atomically (fetchService now builds them).
                  emailRecord = await createEmail({
                    user_id: transaction.user_id,
                    external_id: messageId,
                    source: "gmail",
                    thread_id: email.threadId,
                    sender: email.from ?? undefined,
                    recipients: email.to ?? undefined,
                    cc: email.cc ?? undefined,
                    bcc: email.bcc ?? undefined,
                    subject: email.subject ?? undefined,
                    body_html: email.body,
                    body_plain: email.bodyPlain,
                    sent_at: email.date ? new Date(email.date).toISOString() : undefined,
                    has_attachments: email.hasAttachments || false,
                    attachment_count: email.attachmentCount || 0,
                    participants: email.participants,
                  });
                }

                // Create junction link in communications table.
                // BACKLOG-1718 (R3): pass thread_id so unlinkCommunication can
                // expand the deletion to all sibling emails in the same thread.
                await createCommunication({
                  user_id: transaction.user_id,
                  transaction_id: validatedTransactionId,
                  email_id: emailRecord.id,
                  thread_id: emailRecord.thread_id || undefined,
                  communication_type: "email",
                  link_source: "manual",
                  link_confidence: 1.0,
                  has_attachments: emailRecord.has_attachments || false,
                  is_false_positive: false,
                });
                linkedCount++;
              } catch (emailError) {
                logService.warn(`Failed to fetch Gmail email ${messageId}`, "Transactions", {
                  error: emailError instanceof Error ? emailError.message : "Unknown",
                });
              }
            }
          }
        } catch (gmailError) {
          logService.error("Gmail fetch failed", "Transactions", {
            error: gmailError instanceof Error ? gmailError.message : "Unknown",
          });
        }
      }

      // Legacy fallback: Fetch and save Outlook emails (provider-prefixed IDs)
      if (outlookIds.length > 0) {
        try {
          const isReady = await outlookFetchService.initialize(transaction.user_id);
          if (isReady) {
            for (const messageId of outlookIds) {
              try {
                const email = await outlookFetchService.getEmailById(messageId);

                // BACKLOG-506: Check if email already exists (dedup by external_id)
                let emailRecord = await getEmailByExternalId(transaction.user_id, messageId);

                if (!emailRecord) {
                  // Create email in emails table (content store)
                  // BACKLOG-1722: pass `participants` so the junction is
                  // populated atomically (fetchService now builds them).
                  emailRecord = await createEmail({
                    user_id: transaction.user_id,
                    external_id: messageId,
                    source: "outlook",
                    thread_id: email.threadId,
                    sender: email.from ?? undefined,
                    recipients: email.to ?? undefined,
                    cc: email.cc ?? undefined,
                    bcc: email.bcc ?? undefined,
                    subject: email.subject ?? undefined,
                    body_html: email.body,
                    body_plain: email.bodyPlain,
                    sent_at: email.date ? new Date(email.date).toISOString() : undefined,
                    has_attachments: email.hasAttachments || false,
                    attachment_count: email.attachmentCount || 0,
                    participants: email.participants,
                  });
                }

                // Create junction link in communications table.
                // BACKLOG-1718 (R3): pass thread_id so unlinkCommunication can
                // expand the deletion to all sibling emails in the same thread.
                await createCommunication({
                  user_id: transaction.user_id,
                  transaction_id: validatedTransactionId,
                  email_id: emailRecord.id,
                  thread_id: emailRecord.thread_id || undefined,
                  communication_type: "email",
                  link_source: "manual",
                  link_confidence: 1.0,
                  has_attachments: emailRecord.has_attachments || false,
                  is_false_positive: false,
                });
                linkedCount++;
              } catch (emailError) {
                logService.warn(`Failed to fetch Outlook email ${messageId}`, "Transactions", {
                  error: emailError instanceof Error ? emailError.message : "Unknown",
                });
              }
            }
          }
        } catch (outlookError) {
          logService.error("Outlook fetch failed", "Transactions", {
            error: outlookError instanceof Error ? outlookError.message : "Unknown",
          });
        }
      }

      logService.info("Emails linked successfully", "Transactions", {
        requestedCount: emailIds.length,
        linkedCount,
        transactionId: validatedTransactionId,
      });

      return {
        success: true,
        linkedCount,
      };
    }, { module: "Transactions" }),
  );

  // Get message contacts for contact-first browsing
  ipcMain.handle(
    "transactions:get-message-contacts",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Getting message contacts", "Transactions", { userId });

      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      const contacts = await transactionService.getMessageContacts(validatedUserId);

      return {
        success: true,
        contacts,
      };
    }, { module: "Transactions" }),
  );

  // Get messages for a specific contact
  ipcMain.handle(
    "transactions:get-messages-by-contact",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      userId: string,
      contact: string,
    ): Promise<TransactionResponse> => {
      logService.info("Getting messages by contact", "Transactions", { userId, contact });

      const validatedUserId = validateUserId(userId);
      if (!validatedUserId) {
        throw new ValidationError("User ID validation failed", "userId");
      }

      if (!contact || typeof contact !== "string") {
        throw new ValidationError("Contact is required", "contact");
      }

      const messages = await transactionService.getMessagesByContact(validatedUserId, contact);

      return {
        success: true,
        messages,
      };
    }, { module: "Transactions" }),
  );

  // Link messages to a transaction
  ipcMain.handle(
    "transactions:link-messages",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      messageIds: string[],
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Linking messages to transaction", "Transactions", {
        messageCount: messageIds?.length || 0,
        transactionId,
      });

      // Validate transaction ID
      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError(
          "Transaction ID validation failed",
          "transactionId",
        );
      }

      // Validate message IDs
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        throw new ValidationError(
          "Message IDs must be a non-empty array",
          "messageIds",
        );
      }

      // Validate each message ID
      for (const id of messageIds) {
        if (!id || typeof id !== "string" || id.trim().length === 0) {
          throw new ValidationError(`Invalid message ID: ${id}`, "messageIds");
        }
      }

      await transactionService.linkMessages(messageIds, validatedTransactionId);

      logService.info("Messages linked successfully", "Transactions", {
        messageCount: messageIds.length,
        transactionId: validatedTransactionId,
      });

      return {
        success: true,
      };
    }, { module: "Transactions" }),
  );

  // Unlink messages from a transaction (sets transaction_id to null)
  ipcMain.handle(
    "transactions:unlink-messages",
    wrapHandler(async (
      event: IpcMainInvokeEvent,
      messageIds: string[],
      transactionId?: string,
    ): Promise<TransactionResponse> => {
      logService.info("Unlinking messages from transaction", "Transactions", {
        messageCount: messageIds?.length || 0,
        transactionId,
      });

      // Validate message IDs
      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        throw new ValidationError(
          "Message IDs must be a non-empty array",
          "messageIds",
        );
      }

      // Validate each message ID
      for (const id of messageIds) {
        if (!id || typeof id !== "string" || id.trim().length === 0) {
          throw new ValidationError(`Invalid message ID: ${id}`, "messageIds");
        }
      }

      // TASK-1116: Pass transactionId for thread-based unlinking
      await transactionService.unlinkMessages(messageIds, transactionId);

      logService.info("Messages unlinked successfully", "Transactions", {
        messageCount: messageIds.length,
      });

      return {
        success: true,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-1577: Get removed/unlinked messages for a transaction
  // Joins ignored_communications with messages to show what was removed
  ipcMain.handle(
    "transactions:get-removed-messages",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Getting removed messages", "Transactions", { transactionId });

      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }

      // Query ignored_communications joined with messages to get actual message content
      // Handles both thread-based suppression and per-message suppression
      const sql = `
        SELECT DISTINCT
          ic.id as ignored_id,
          ic.thread_id as ic_thread_id,
          ic.reason,
          ic.ignored_at,
          m.id as message_id,
          m.body_text as body,
          m.subject,
          m.channel,
          m.thread_id,
          m.sent_at,
          m.received_at,
          m.participants,
          m.participants_flat,
          m.direction
        FROM ignored_communications ic
        LEFT JOIN messages m ON (
          (ic.thread_id IS NOT NULL AND ic.thread_id != '' AND m.thread_id = ic.thread_id)
          OR (ic.original_communication_id IS NOT NULL AND m.id = ic.original_communication_id)
        )
        WHERE ic.transaction_id = ?
        AND m.id IS NOT NULL
        ORDER BY ic.ignored_at DESC, m.sent_at DESC
      `;

      const rows = dbAll(sql, [validatedTransactionId]);

      logService.info("Retrieved removed messages", "Transactions", {
        transactionId: validatedTransactionId,
        count: rows.length,
      });

      return {
        success: true,
        removedMessages: rows,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-1578: Get removed/unlinked emails for a transaction
  // Joins ignored_communications with emails to show what was removed
  ipcMain.handle(
    "transactions:get-removed-emails",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Getting removed emails", "Transactions", { transactionId });

      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }

      // Query ignored_communications joined with emails to get actual email content
      const sql = `
        SELECT DISTINCT
          ic.id as ignored_id,
          ic.email_id as ic_email_id,
          ic.reason,
          ic.ignored_at,
          e.id as email_id,
          e.subject,
          e.sender,
          e.recipients,
          e.cc,
          e.sent_at,
          e.thread_id,
          SUBSTR(e.body_plain, 1, 200) as body_preview,
          e.body_plain,
          e.has_attachments,
          e.source
        FROM ignored_communications ic
        JOIN emails e ON (
          (ic.email_id IS NOT NULL AND ic.email_id = e.id)
          OR (ic.original_communication_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM communications c
                          WHERE c.id = ic.original_communication_id AND c.email_id = e.id))
        )
        WHERE ic.transaction_id = ?
        AND e.id IS NOT NULL
        ORDER BY ic.ignored_at DESC
      `;

      const rows = dbAll(sql, [validatedTransactionId]);

      logService.info("Retrieved removed emails", "Transactions", {
        transactionId: validatedTransactionId,
        count: rows.length,
      });

      return {
        success: true,
        removedEmails: rows,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-1578: Restore a removed email (re-link + remove suppression)
  ipcMain.handle(
    "transactions:restore-removed-email",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      ignoredCommId: string,
      emailId: string,
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Restoring removed email", "Transactions", {
        ignoredCommId,
        emailId,
        transactionId,
      });

      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }

      if (!ignoredCommId || typeof ignoredCommId !== "string") {
        throw new ValidationError("Ignored communication ID is required", "ignoredCommId");
      }

      if (!emailId || typeof emailId !== "string") {
        throw new ValidationError("Email ID is required", "emailId");
      }

      // Get transaction to get user_id
      const transaction = await transactionService.getTransactionDetails(validatedTransactionId);
      if (!transaction) {
        throw new ValidationError("Transaction not found", "transactionId");
      }

      // BACKLOG-1718 (R4): Thread-aware restore — symmetric with R3 unlink expansion.
      const { restoredCount } = await transactionService.restoreRemovedEmailThread(
        ignoredCommId,
        emailId,
        validatedTransactionId,
        transaction.user_id,
      );

      logService.info("Removed email(s) restored", "Transactions", {
        ignoredCommId,
        emailId,
        transactionId: validatedTransactionId,
        restoredCount,
      });

      return {
        success: true,
        restoredCount,
      };
    }, { module: "Transactions" }),
  );

  // BACKLOG-1577: Restore a removed message (re-link + remove suppression)
  ipcMain.handle(
    "transactions:restore-removed-message",
    wrapHandler(async (
      _event: IpcMainInvokeEvent,
      ignoredCommId: string,
      messageIds: string[],
      transactionId: string,
    ): Promise<TransactionResponse> => {
      logService.info("Restoring removed message", "Transactions", {
        ignoredCommId,
        messageCount: messageIds?.length || 0,
        transactionId,
      });

      const validatedTransactionId = validateTransactionId(transactionId);
      if (!validatedTransactionId) {
        throw new ValidationError("Transaction ID validation failed", "transactionId");
      }

      if (!ignoredCommId || typeof ignoredCommId !== "string") {
        throw new ValidationError("Ignored communication ID is required", "ignoredCommId");
      }

      if (!Array.isArray(messageIds) || messageIds.length === 0) {
        throw new ValidationError("Message IDs must be a non-empty array", "messageIds");
      }

      // Step 1: Remove the suppression record so auto-link does not suppress again
      await removeIgnoredCommunication(ignoredCommId);

      // Step 2: Re-link the messages to the transaction
      await transactionService.linkMessages(messageIds, validatedTransactionId);

      logService.info("Removed message restored", "Transactions", {
        ignoredCommId,
        messageCount: messageIds.length,
        transactionId: validatedTransactionId,
      });

      return {
        success: true,
      };
    }, { module: "Transactions" }),
  );
}
