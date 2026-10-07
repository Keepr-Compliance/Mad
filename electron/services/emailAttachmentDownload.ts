/**
 * BACKLOG-3683: shared by the submit (submissionService) and the one-PDF export
 * (enhancedExportService), so both download a missing email attachment before
 * deciding it is missing. Moved verbatim from submissionService; only the log
 * prefix is now a parameter.
 */
import { net } from "electron";
import databaseService from "./databaseService";
import logService from "./logService";
import emailAttachmentService from "./emailAttachmentService";
import gmailFetchService from "./gmailFetchService";
import outlookFetchService from "./outlookFetchService";
import { TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL } from "./db/submissionEmailSql";

/**
 * BACKLOG-1369: Download missing email attachments for a transaction.
 * Finds emails linked to this transaction that have has_attachments=true and
 * are missing the BYTES of at least one attachment, then downloads from the
 * provider.
 *
 * BACKLOG-3389: "missing the bytes" replaced "have no attachment records".
 * A normal sync writes a metadata-only row (`storage_path` NULL), which
 * satisfied the old row-existence test — so the download was skipped and the
 * gather then discarded the row for having nothing to upload. The predicate
 * and the reasoning live in `db/submissionEmailSql.ts`.
 */
export async function downloadMissingEmailAttachments(
  transactionId: string,
  logTag: string = "[Submission]"
): Promise<void> {
  // Check network connectivity first
  try {
    if (!net.isOnline()) {
      logService.warn(
        `${logTag} Cannot download missing attachments: device is offline`,
        "SubmissionService",
        { transactionId }
      );
      return;
    }
  } catch {
    // net.isOnline() may not be available in all contexts; proceed anyway
  }

  try {
    const db = databaseService.getRawDatabase();

    // Find emails linked to this transaction that have attachments but no records
    const emailsMissing = db
      .prepare(TRANSACTION_EMAILS_MISSING_ATTACHMENTS_SQL)
      .all(transactionId) as { id: string; external_id: string; source: string; user_id: string }[];

    if (emailsMissing.length === 0) return;

    logService.info(
      `${logTag} Downloading attachments for ${emailsMissing.length} emails before export`,
      "SubmissionService",
      { transactionId }
    );

    // Group by source for efficient provider initialization
    const outlookEmails = emailsMissing.filter(e => e.source === "outlook");
    const gmailEmails = emailsMissing.filter(e => e.source === "gmail");

    if (outlookEmails.length > 0) {
      const userId = outlookEmails[0].user_id;
      try {
        const isReady = await outlookFetchService.initialize(userId);
        if (isReady) {
          for (const email of outlookEmails) {
            try {
              const graphAttachments = await outlookFetchService.getAttachments(email.external_id);
              if (graphAttachments.length > 0) {
                await emailAttachmentService.downloadEmailAttachments(
                  email.user_id, email.id, email.external_id, "outlook",
                  graphAttachments.map((att: { id: string; name: string; contentType: string; size: number }) => ({
                    filename: att.name || "attachment",
                    mimeType: att.contentType || "application/octet-stream",
                    size: att.size || 0,
                    // BACKLOG-3187: a Graph attachment has no MIME part, so no identity
                    // beyond its own id. Explicitly null — the field is required so this
                    // decision cannot be left unmade at a new call site.
                    partId: null,
                    attachmentId: att.id,
                  })),
                );
              }
            } catch (err) {
              logService.warn(`${logTag} Failed to download Outlook attachment for export`, "SubmissionService", {
                emailId: email.id, error: err instanceof Error ? err.message : "Unknown",
              });
            }
          }
        }
      } catch (err) {
        logService.warn(`${logTag} Outlook init failed for attachment download`, "SubmissionService", {
          error: err instanceof Error ? err.message : "Unknown",
        });
      }
    }

    if (gmailEmails.length > 0) {
      const userId = gmailEmails[0].user_id;
      try {
        const isReady = await gmailFetchService.initialize(userId);
        if (isReady) {
          for (const email of gmailEmails) {
            try {
              const fullEmail = await gmailFetchService.getEmailById(email.external_id);
              if (fullEmail.attachments && fullEmail.attachments.length > 0) {
                await emailAttachmentService.downloadEmailAttachments(
                  email.user_id, email.id, email.external_id, "gmail",
                  fullEmail.attachments.map((att: { filename?: string; name?: string; mimeType?: string; contentType?: string; size?: number; partId?: string; attachmentId?: string; id?: string }) => ({
                    filename: att.filename || att.name || "attachment",
                    mimeType: att.mimeType || att.contentType || "application/octet-stream",
                    size: att.size || 0,
                    // BACKLOG-3187: identity (Gmail's immutable MIME part id) travels
                    // separately from the fetch token below, which rotates between calls.
                    partId: att.partId ?? null,
                    attachmentId: att.attachmentId || att.id || "",
                  })),
                );
              }
            } catch (err) {
              logService.warn(`${logTag} Failed to download Gmail attachment for export`, "SubmissionService", {
                emailId: email.id, error: err instanceof Error ? err.message : "Unknown",
              });
            }
          }
        }
      } catch (err) {
        logService.warn(`${logTag} Gmail init failed for attachment download`, "SubmissionService", {
          error: err instanceof Error ? err.message : "Unknown",
        });
      }
    }
  } catch (err) {
    logService.warn(`${logTag} Failed to download missing email attachments for export`, "SubmissionService", {
      transactionId,
      error: err instanceof Error ? err.message : "Unknown",
    });
  }
}
