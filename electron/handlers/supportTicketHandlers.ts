/**
 * Support Ticket IPC Handlers
 * TASK-2180: Desktop In-App Support Ticket Dialog with Diagnostics
 *
 * Exposes support ticket functionality to the renderer process via IPC.
 * Handles diagnostics, screenshots, ticket creation, and attachment uploads.
 */

import { ipcMain } from "electron";
import * as Sentry from "@sentry/electron/main";
import { scrubServerErrorText } from "../utils/redactSensitive";
import {
  collectDiagnostics,
  captureScreenshot,
  appendDiagnosticsToDescription,
  type AppDiagnostics,
} from "../services/supportTicketService";
import supabaseService from "../services/supabaseService";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";

/** Parameters for creating a support ticket */
interface CreateTicketParams {
  subject: string;
  description: string;
  priority: string;
  category_id: string | null;
  requester_email: string;
  requester_name: string;
}

/**
 * Register support ticket IPC handlers
 */
export function registerSupportTicketHandlers(): void {
  /**
   * Collect app diagnostics for a support ticket.
   * Returns sanitized diagnostics data (PII-safe).
   */
  ipcMain.handle(
    "support:collect-diagnostics",
    wrapHandler(async () => {
      logService.debug(
        "[Support] Collecting diagnostics",
        "SupportTicketHandlers"
      );
      const diagnostics = await collectDiagnostics();
      return { success: true, diagnostics };
    }, { module: "SupportTicketHandlers" })
  );

  /**
   * Capture a screenshot of the primary screen.
   * Returns base64-encoded PNG string, or null on failure.
   */
  ipcMain.handle(
    "support:capture-screenshot",
    wrapHandler(async () => {
      logService.debug(
        "[Support] Capturing screenshot",
        "SupportTicketHandlers"
      );
      const screenshot = await captureScreenshot();
      return { success: true, screenshot };
    }, { module: "SupportTicketHandlers" })
  );

  /**
   * Get support categories from Supabase.
   */
  ipcMain.handle(
    "support:get-categories",
    wrapHandler(async () => {
      logService.debug(
        "[Support] Loading categories",
        "SupportTicketHandlers"
      );
      const client = supabaseService.getClient();
      const { data, error } = await client
        .from("support_categories")
        .select("*")
        .eq("is_active", true)
        .order("sort_order");

      // BACKLOG-2431: scrubbed — a raw throw reaches wrapHandler's
      // captureException unscrubbed, and beforeSend only covers auto-updater.
      if (error) throw scrubbedDbError(error, "Loading support categories failed");
      return { success: true, categories: data ?? [] };
    }, { module: "SupportTicketHandlers" })
  );

  /**
   * Create a support ticket and upload attachments (screenshot + diagnostics).
   * This is the main submission endpoint that handles the full flow:
   * 1. Create ticket via RPC
   * 2. Upload screenshot if present
   * 3. Upload diagnostics JSON
   */
  ipcMain.handle(
    "support:submit-ticket",
    wrapHandler(async (
      _event,
      params: CreateTicketParams,
      screenshotBase64: string | null,
      diagnosticsData: AppDiagnostics | null
    ) => {
      logService.info(
        "[Support] Submitting ticket",
        "SupportTicketHandlers",
        { subject: params.subject.substring(0, 50) }
      );

      const client = supabaseService.getClient();

      // BACKLOG-1917: Surface diagnostics inline. Append a human-readable,
      // PII-safe diagnostics summary to the ticket description so it is visible
      // in EVERY existing ticket view (admin portal detail page + email copy)
      // with no new UI and no schema change. The diagnostics object is already
      // sanitized by the collector; the composer only reads status/versions/
      // counts (never raw errors, UDID/serial, or tokens). The diagnostics.json
      // attachment path below is unchanged (belt-and-suspenders).
      const descriptionWithDiagnostics = appendDiagnosticsToDescription(
        params.description,
        diagnosticsData
      );

      // Step 1: Create the ticket
      const { data: ticketData, error: ticketError } = await client.rpc(
        "support_create_ticket",
        {
          p_subject: params.subject,
          p_description: descriptionWithDiagnostics,
          p_priority: params.priority,
          p_category_id: params.category_id || null,
          p_subcategory_id: null,
          p_requester_email: params.requester_email,
          p_requester_name: params.requester_name,
          p_source_channel: "in_app_redirect",
        }
      );

      if (ticketError) {
        logService.error(
          "[Support] Ticket creation failed",
          "SupportTicketHandlers",
          { error: ticketError.message }
        );
        // BACKLOG-2431: this RPC is called with `p_requester_email`, and a
        // CHECK violation renders the whole failing row into `details`. A raw
        // `throw ticketError` puts that object into wrapHandler's
        // captureException verbatim.
        throw scrubbedDbError(ticketError, "Ticket creation failed");
      }

      const ticket = ticketData as { id: string; ticket_number: number };
      if (!ticket?.id) {
        throw new Error("Ticket creation returned no ticket ID");
      }

      logService.info(
        `[Support] Ticket #${ticket.ticket_number} created`,
        "SupportTicketHandlers",
        { ticketId: ticket.id }
      );

      // Step 2: Upload screenshot if present
      if (screenshotBase64) {
        try {
          await uploadAttachment(
            client,
            ticket.id,
            "screenshot.png",
            Buffer.from(screenshotBase64, "base64"),
            "image/png"
          );
          logService.debug(
            "[Support] Screenshot uploaded",
            "SupportTicketHandlers"
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logService.warn(
            "[Support] Screenshot upload failed (ticket still created)",
            "SupportTicketHandlers",
            { error: message }
          );
          // BACKLOG-1916: surface silent attachment drops so they are observable.
          Sentry.captureMessage(
            "[Support] Screenshot upload failed (ticket still created)",
            {
              level: "warning",
              tags: {
                component: "support",
                operation: "submit-ticket",
                attachment: "screenshot",
              },
              extra: { ticketId: ticket.id, error: message },
            }
          );
        }
      }

      // Step 3: Upload diagnostics JSON if present
      if (diagnosticsData) {
        const jsonStr = JSON.stringify(diagnosticsData, null, 2);
        const jsonBuffer = Buffer.from(jsonStr, "utf-8");

        try {
          await uploadAttachment(
            client,
            ticket.id,
            "diagnostics.json",
            jsonBuffer,
            "application/json"
          );
          logService.debug(
            "[Support] Diagnostics uploaded",
            "SupportTicketHandlers"
          );
        } catch (jsonErr) {
          // BACKLOG-1916: the support-attachments bucket historically rejected
          // 'application/json' (allowlist gap), which silently dropped
          // diagnostics. Belt-and-suspenders: retry as 'text/plain', which is
          // already allowlisted, so even a misconfigured/older bucket captures
          // diagnostics. The file name stays diagnostics.json.
          const jsonMessage =
            jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
          logService.warn(
            "[Support] Diagnostics JSON upload failed, retrying as text/plain",
            "SupportTicketHandlers",
            { error: jsonMessage }
          );

          try {
            await uploadAttachment(
              client,
              ticket.id,
              "diagnostics.json",
              jsonBuffer,
              "text/plain"
            );
            logService.debug(
              "[Support] Diagnostics uploaded via text/plain fallback",
              "SupportTicketHandlers"
            );
            // Still surface that the primary path failed so the allowlist
            // regression is observable even when the fallback saves the data.
            Sentry.captureMessage(
              "[Support] Diagnostics application/json upload failed; text/plain fallback succeeded",
              {
                level: "warning",
                tags: {
                  component: "support",
                  operation: "submit-ticket",
                  attachment: "diagnostics",
                  fallback: "text/plain",
                },
                extra: { ticketId: ticket.id, error: jsonMessage },
              }
            );
          } catch (fallbackErr) {
            const fallbackMessage =
              fallbackErr instanceof Error
                ? fallbackErr.message
                : String(fallbackErr);
            logService.warn(
              "[Support] Diagnostics upload failed (ticket still created)",
              "SupportTicketHandlers",
              { error: fallbackMessage }
            );
            // BACKLOG-1916: both attempts failed — this is a real drop, make
            // it observable instead of silently swallowing it.
            Sentry.captureMessage(
              "[Support] Diagnostics upload failed (ticket still created)",
              {
                level: "warning",
                tags: {
                  component: "support",
                  operation: "submit-ticket",
                  attachment: "diagnostics",
                },
                extra: {
                  ticketId: ticket.id,
                  jsonError: jsonMessage,
                  fallbackError: fallbackMessage,
                },
              }
            );
          }
        }
      }

      return {
        success: true,
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
      };
    }, { module: "SupportTicketHandlers" })
  );

  logService.debug(
    "Support ticket handlers registered",
    "SupportTicketHandlers"
  );
}

/**
 * Upload a file to Supabase Storage and register it as an attachment.
 *
 * BACKLOG-2431: BOTH throws below carry SCRUBBED text. Every caller catches
 * this and puts `err.message` straight into a Sentry `extra` field, so a raw
 * throw here re-leaks whatever `reportAttachmentStepFailure` just scrubbed —
 * one failure would emit two events, one clean and one carrying the value
 * verbatim. Scrubbing at the throw covers those callers and any added later.
 *
 * The scrubbed text is not user-facing: all three callers swallow it (the
 * ticket is still created) and only log it.
 */
async function uploadAttachment(
  client: ReturnType<typeof supabaseService.getClient>,
  ticketId: string,
  fileName: string,
  fileBuffer: Buffer,
  contentType: string
): Promise<void> {
  const attachmentId = crypto.randomUUID();
  const storagePath = `${ticketId}/${attachmentId}/${fileName}`;

  // Upload to storage
  const { error: uploadError } = await client.storage
    .from("support-attachments")
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: false,
    });

  if (uploadError) {
    reportAttachmentStepFailure("storage-upload", uploadError.message, {
      ticketId,
      fileName,
      contentType,
      fileBytes: fileBuffer.length,
    });
    throw new Error(
      `Storage upload failed: ${scrubServerErrorText(uploadError.message)}`,
    );
  }

  // Register the attachment via RPC
  const { error: attachError } = await client.rpc("support_add_attachment", {
    p_ticket_id: ticketId,
    p_message_id: null,
    p_file_name: fileName,
    p_file_size: fileBuffer.length,
    p_file_type: contentType,
    p_storage_path: storagePath,
  });

  if (attachError) {
    reportAttachmentStepFailure("register-attachment", attachError.message, {
      ticketId,
      fileName,
      contentType,
      fileBytes: fileBuffer.length,
    });
    throw new Error(
      `Attachment registration failed: ${scrubServerErrorText(attachError.message)}`,
    );
  }
}

/**
 * BACKLOG-2431: turn a Supabase/Postgres error into one that is safe to throw.
 *
 * A raw `throw error` from a handler lands in `wrapHandler`, which calls
 * `Sentry.captureException(error)` with the object untouched — and `beforeSend`
 * in main.ts does not help, because `scrubUpdaterEventPII` returns the event
 * unchanged unless it is tagged `component: "auto-updater"`.
 *
 * `message` is not the only field that carries user data. Postgres renders the
 * whole offending row into `details` on a CHECK violation:
 *
 *   DETAIL: Failing row contains (1, jane.homebuyer@example.com, bogus).
 *
 * and `support_tickets` has a `requester_email` column plus several CHECKs, so
 * this is a live vector rather than a theoretical one. `hint` is server text
 * too. All three are scrubbed; `code` (e.g. "23514") is a fixed identifier with
 * no user data and is kept, because it is what makes the failure diagnosable.
 */
function scrubbedDbError(error: unknown, prefix: string): Error {
  const e = (error ?? {}) as {
    message?: string;
    details?: string;
    hint?: string;
    code?: string;
  };
  const parts = [
    scrubServerErrorText(e.message),
    e.details ? `details: ${scrubServerErrorText(e.details)}` : "",
    e.hint ? `hint: ${scrubServerErrorText(e.hint)}` : "",
    e.code ? `code: ${e.code}` : "",
  ].filter(Boolean);
  const scrubbed = new Error(`${prefix}: ${parts.join(" | ")}`);
  scrubbed.name = "ScrubbedSupabaseError";
  return scrubbed;
}

/**
 * BACKLOG-2431: name which half of `uploadAttachment` failed.
 *
 * The three callers below already capture a message when an attachment does not
 * make it, but both failure modes reach them as the same collapsed string, so
 * "mime type application/gzip is not supported" (a storage rejection, fixable
 * by us) is indistinguishable from an RPC/RLS rejection. This adds the step as
 * a tag; the callers keep reporting the user-visible outcome.
 *
 * `fileBuffer` is never sent — for the screenshot path it is a raw PNG of the
 * user's screen. Only its length goes out. The reason is server-authored text,
 * so it is scrubbed of embedded emails AND local paths: `beforeSend` in main.ts
 * only scrubs events tagged `component: "auto-updater"`.
 */
function reportAttachmentStepFailure(
  step: "storage-upload" | "register-attachment",
  reason: string,
  context: { ticketId: string; fileName: string; contentType: string; fileBytes: number },
): void {
  try {
    Sentry.captureMessage(`[Support] Attachment ${step} failed`, {
      level: "warning",
      tags: { component: "support", operation: "upload-attachment", step },
      extra: { ...context, reason: scrubServerErrorText(reason) },
    });
  } catch {
    // Telemetry must never change the outcome of a ticket submission.
  }
}
