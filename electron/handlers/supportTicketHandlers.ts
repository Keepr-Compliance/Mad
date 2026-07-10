/**
 * Support Ticket IPC Handlers
 * TASK-2180: Desktop In-App Support Ticket Dialog with Diagnostics
 *
 * Exposes support ticket functionality to the renderer process via IPC.
 * Handles diagnostics, screenshots, ticket creation, and attachment uploads.
 */

import { ipcMain } from "electron";
import * as Sentry from "@sentry/electron/main";
import {
  collectDiagnostics,
  captureScreenshot,
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

      if (error) throw error;
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

      // Step 1: Create the ticket
      const { data: ticketData, error: ticketError } = await client.rpc(
        "support_create_ticket",
        {
          p_subject: params.subject,
          p_description: params.description,
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
        throw ticketError;
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
    throw new Error(`Storage upload failed: ${uploadError.message}`);
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
    throw new Error(`Attachment registration failed: ${attachError.message}`);
  }
}
