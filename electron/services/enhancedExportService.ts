import path from "path";
import fs from "fs/promises";
import { app } from "electron";
import folderExportService from "./folderExportService";
import logService from "./logService";
import { Transaction, Communication } from "../types/models";
import type { TransactionWithDetails } from "./transactionService/types";
import { isEmailMessage, isTextMessage } from "../utils/channelHelpers";
import { sanitizeFileSystemName } from "../utils/fileUtils";

/**
 * Enhanced Export Service
 * Supports multiple export formats and content filtering
 * - PDF Report
 * - Excel (.xlsx) - CSV format for now
 * - CSV
 * - JSON
 * - TXT + EML files in folders
 */

interface ExportOptions {
  contentType?: "text" | "email" | "both";
  exportFormat?: "pdf" | "excel" | "csv" | "json" | "txt_eml";
  startDate?: string;
  endDate?: string;
  summaryOnly?: boolean; // If true, only export summary + indexes (no full content)
  attachmentType?: "all" | "email" | "text" | "none";
}

class EnhancedExportService {
  constructor() {}

  /**
   * Export transaction with enhanced options
   * @param transaction - Transaction data
   * @param communications - All communications for the transaction
   * @param options - Export options
   * @returns Path to exported file/folder
   */
  async exportTransaction(
    transaction: TransactionWithDetails,
    communications: Communication[],
    options: ExportOptions = {},
  ): Promise<string> {
    const {
      contentType = "both",
      exportFormat = "pdf",
      startDate: optionStartDate,
      endDate: optionEndDate,
      summaryOnly = false,
      attachmentType = "none",
    } = options;

    try {
      logService.info("[Enhanced Export] Starting export:", "EnhancedExport", {
        format: exportFormat,
        contentType,
        transactionId: transaction.id,
        propertyAddress: transaction.property_address,
        startDate: optionStartDate || "not set",
        endDate: optionEndDate || "not set",
      });

      // Filter communications by date range
      // If dates aren't provided in options, use transaction dates
      const startDate = optionStartDate || (transaction.started_at as string | undefined);
      const endDate = optionEndDate || (transaction.closed_at as string | undefined);

      const totalBefore = communications.length;
      let filteredComms = this._filterCommunicationsByDate(
        communications,
        startDate,
        endDate,
      );
      const afterDateFilter = filteredComms.length;

      if (startDate || endDate) {
        logService.info(
          `[Enhanced Export] Date filtering: ${totalBefore} -> ${afterDateFilter} communications (filtered ${totalBefore - afterDateFilter} outside date range)`,
          "EnhancedExport",
          {
            startDate: startDate || "none",
            endDate: endDate || "none",
            filtered: totalBefore - afterDateFilter,
          },
        );
      }

      // Filter by content type
      filteredComms = this._filterByContentType(filteredComms, contentType);

      // Sort descending (most recent first)
      filteredComms.sort((a, b) => {
        const dateA = a.sent_at ? new Date(a.sent_at as string).getTime() : 0;
        const dateB = b.sent_at ? new Date(b.sent_at as string).getTime() : 0;
        return dateB - dateA;
      });

      logService.info(
        `[Enhanced Export] Filtered to ${filteredComms.length} communications`,
        "EnhancedExport",
      );

      // Export based on format
      let exportPath: string;
      switch (exportFormat) {
        case "pdf":
          exportPath = await this._exportPDF(transaction, filteredComms, summaryOnly, attachmentType);
          break;
        case "excel":
        case "csv":
          exportPath = await this._exportCSV(
            transaction,
            filteredComms,
            exportFormat,
          );
          break;
        case "json":
          exportPath = await this._exportJSON(transaction, filteredComms);
          break;
        case "txt_eml":
          exportPath = await this._exportTxtEml(transaction, filteredComms);
          break;
        default:
          throw new Error(`Unknown export format: ${exportFormat}`);
      }

      logService.info("[Enhanced Export] Export complete:", "EnhancedExport", { exportPath });
      return exportPath;
    } catch (error) {
      logService.error("[Enhanced Export] Export failed:", "EnhancedExport", { error });
      throw error;
    }
  }

  /**
   * Filter communications by date range
   * @private
   */
  private _filterCommunicationsByDate(
    communications: Communication[],
    startDate?: string,
    endDate?: string,
  ): Communication[] {
    if (!startDate && !endDate) {
      return communications;
    }

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : null;

    // BACKLOG-2343: The audit window end (e.g. the transaction's closed_at) is a
    // DATE like "2026-07-29", which `new Date()` parses as UTC midnight
    // (2026-07-29T00:00:00Z). A text sent late on the closing day in a timezone
    // west of UTC (e.g. Jul 28 evening America/Chicago) is stored with a UTC
    // sent_at that rolls into the next calendar day (2026-07-29T0X:00:00Z), so a
    // naive `commDate > end` check DROPS it — the exported Audit Summary then
    // reads "TOTAL TEXT MESSAGES: 0" even though the message is in-window.
    // Make the end boundary inclusive of the entire closing day by advancing it
    // one day, mirroring the folder-export handler
    // (transactionExportHandlers.ts, "Add a day to end date to include messages
    // on the closing day"). Errs toward INCLUDING borderline messages, which is
    // the safe direction for an audit export.
    if (end) end.setDate(end.getDate() + 1);

    return communications.filter((comm) => {
      // Prefer sent_at; fall back to received_at (parity with the folder-export
      // handler) so a message missing sent_at is not silently dropped as 1970.
      const commDate = new Date((comm.sent_at ?? comm.received_at) as string);
      if (start && commDate < start) return false;
      if (end && commDate > end) return false;
      return true;
    });
  }

  /**
   * Filter by content type (text/email/both)
   * @private
   */
  private _filterByContentType(
    communications: Communication[],
    contentType: "text" | "email" | "both",
  ): Communication[] {
    if (contentType === "both") {
      return communications;
    }

    if (contentType === "email") {
      return communications.filter((c) => isEmailMessage(c));
    }

    if (contentType === "text") {
      return communications.filter((c) => isTextMessage(c));
    }

    return communications;
  }

  /**
   * Export as PDF using folder export service's combined PDF functionality
   * This generates individual PDFs (summary, emails, texts) and combines them
   * into a single document for a comprehensive audit report
   * @private
   */
  private async _exportPDF(
    transaction: TransactionWithDetails,
    communications: Communication[],
    summaryOnly: boolean = false,
    attachmentType: "all" | "email" | "text" | "none" = "none",
  ): Promise<string> {
    const downloadsPath = app.getPath("downloads");
    const needsAttachments = !summaryOnly && attachmentType !== "none";

    if (needsAttachments) {
      // Create a folder: PDF + attachments subfolder
      const folderName = sanitizeFileSystemName(
        `Transaction_${transaction.property_address}_${Date.now()}`,
      );
      const folderPath = path.join(downloadsPath, folderName);
      await fs.mkdir(folderPath, { recursive: true });

      // Generate the combined PDF inside the folder
      const pdfPath = path.join(folderPath, "Combined_Report.pdf");
      await folderExportService.exportTransactionToCombinedPDF(
        transaction,
        communications,
        pdfPath,
        summaryOnly,
      );

      // Export attachments into an /attachments subfolder
      const attachmentsPath = path.join(folderPath, "attachments");
      await fs.mkdir(attachmentsPath, { recursive: true });

      // Filter communications by attachment type
      let attachmentComms = communications;
      if (attachmentType === "email") {
        attachmentComms = communications.filter((c) => isEmailMessage(c));
      } else if (attachmentType === "text") {
        attachmentComms = communications.filter((c) => isTextMessage(c));
      }

      // Use folderExportService's attachment export
      await folderExportService.exportAttachments(transaction, attachmentComms, attachmentsPath);

      return folderPath;
    } else {
      // Simple PDF file, no attachments
      const suffix = summaryOnly ? "Summary" : "Full";
      const fileName = sanitizeFileSystemName(
        `Transaction_${suffix}_${transaction.property_address}_${Date.now()}.pdf`,
      );
      const outputPath = path.join(downloadsPath, fileName);

      return await folderExportService.exportTransactionToCombinedPDF(
        transaction,
        communications,
        outputPath,
        summaryOnly,
      );
    }
  }

  /**
   * Export as CSV or Excel (CSV format)
   * @private
   */
  private async _exportCSV(
    transaction: Transaction,
    communications: Communication[],
    format: "excel" | "csv",
  ): Promise<string> {
    const downloadsPath = app.getPath("downloads");
    const ext = format === "excel" ? "xlsx" : "csv";
    const fileName = sanitizeFileSystemName(
      `Transaction_${transaction.property_address}_${Date.now()}.${ext}`,
    );
    const outputPath = path.join(downloadsPath, fileName);

    // Create CSV content
    const headers = [
      "Date",
      "Type",
      "From",
      "To",
      "Subject",
      "Body Preview",
      "Has Attachments",
      "Attachment Count",
    ];

    const rows = communications.map((comm) => [
      new Date(comm.sent_at as string).toLocaleString(),
      comm.communication_type || "email",
      comm.sender || "",
      comm.recipients || "",
      comm.subject || "",
      (comm.body_plain || "").substring(0, 200).replace(/"/g, '""'),
      comm.has_attachments ? "Yes" : "No",
      comm.attachment_count || 0,
    ]);

    // Add transaction info at the top
    const csvLines = [
      `Transaction Report: ${transaction.property_address}`,
      `Generated: ${new Date().toLocaleString()}`,
      `Representation Start: ${
        transaction.started_at
          ? new Date(transaction.started_at).toLocaleDateString()
          : "N/A"
      }`,
      `Closing Date: ${
        transaction.closed_at
          ? new Date(transaction.closed_at).toLocaleDateString()
          : "N/A"
      }`,
      `Total Communications: ${communications.length}`,
      "",
      headers.map((h) => `"${h}"`).join(","),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
    ];

    const csvContent = csvLines.join("\n");

    await fs.writeFile(outputPath, csvContent, "utf8");

    return outputPath;
  }

  /**
   * Export as JSON
   * @private
   */
  private async _exportJSON(
    transaction: Transaction,
    communications: Communication[],
  ): Promise<string> {
    const downloadsPath = app.getPath("downloads");
    const fileName = sanitizeFileSystemName(
      `Transaction_${transaction.property_address}_${Date.now()}.json`,
    );
    const outputPath = path.join(downloadsPath, fileName);

    const exportData = {
      transaction: {
        id: transaction.id,
        property_address: transaction.property_address,
        transaction_type: transaction.transaction_type,
        status: transaction.status,
        started_at: transaction.started_at,
        closed_at: transaction.closed_at,
        sale_price: transaction.sale_price,
        listing_price: transaction.listing_price,
        earnest_money_amount: transaction.earnest_money_amount,
        extraction_confidence: transaction.extraction_confidence,
        total_communications_count: communications.length,
        exported_at: new Date().toISOString(),
      },
      communications: communications.map((comm) => ({
        id: comm.id,
        type: comm.communication_type,
        sender: comm.sender,
        recipients: comm.recipients,
        cc: comm.cc,
        bcc: comm.bcc,
        subject: comm.subject,
        body_plain: comm.body_plain,
        sent_at: comm.sent_at,
        received_at: comm.received_at,
        has_attachments: comm.has_attachments,
        attachment_count: comm.attachment_count,
        attachment_metadata: comm.attachment_metadata,
        keywords_detected: comm.keywords_detected,
        parties_involved: comm.parties_involved,
        relevance_score: comm.relevance_score,
      })),
    };

    await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2), "utf8");

    return outputPath;
  }

  /**
   * Export as TXT + EML files in folder structure
   * Creates: {address}_{client}/emails/ and texts/
   * @private
   */
  private async _exportTxtEml(
    transaction: Transaction,
    communications: Communication[],
  ): Promise<string> {
    const downloadsPath = app.getPath("downloads");
    const folderName = sanitizeFileSystemName(
      `${transaction.property_address}_Export_${Date.now()}`,
    );
    const basePath = path.join(downloadsPath, folderName);

    // Create folder structure
    await fs.mkdir(basePath, { recursive: true });
    const emailsPath = path.join(basePath, "emails");
    const textsPath = path.join(basePath, "texts");
    await fs.mkdir(emailsPath, { recursive: true });
    await fs.mkdir(textsPath, { recursive: true });

    // Export emails as .eml files
    const emails = communications.filter(
      (c) => isEmailMessage(c),
    );
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const emlContent = this._createEMLContent(email);
      const emlFileName = sanitizeFileSystemName(
        `${i + 1}_${email.subject || "no_subject"}.eml`,
      );
      await fs.writeFile(
        path.join(emailsPath, emlFileName),
        emlContent,
        "utf8",
      );
    }

    // Export texts as .txt files
    const texts = communications.filter((c) => isTextMessage(c));
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      const txtContent = this._createTextContent(text);
      const txtFileName = sanitizeFileSystemName(
        `${i + 1}_${new Date(text.sent_at as string).toISOString().split("T")[0]}.txt`,
      );
      await fs.writeFile(path.join(textsPath, txtFileName), txtContent, "utf8");
    }

    // Create summary.txt
    const summaryContent = this._createSummary(transaction, communications);
    await fs.writeFile(
      path.join(basePath, "SUMMARY.txt"),
      summaryContent,
      "utf8",
    );

    return basePath;
  }

  /**
   * Create EML file content (RFC 822 format)
   * @private
   */
  private _createEMLContent(email: Communication): string {
    const lines: string[] = [];

    lines.push(`From: ${email.sender || "Unknown"}`);
    if (email.recipients) lines.push(`To: ${email.recipients}`);
    if (email.cc) lines.push(`Cc: ${email.cc}`);
    if (email.bcc) lines.push(`Bcc: ${email.bcc}`);
    lines.push(`Subject: ${email.subject || "(No Subject)"}`);
    lines.push(
      `Date: ${
        email.sent_at
          ? new Date(email.sent_at as string).toUTCString()
          : "Unknown"
      }`,
    );
    if (email.has_attachments) {
      lines.push(`X-Attachments: ${email.attachment_count || 0} attachment(s)`);
    }
    lines.push("Content-Type: text/plain; charset=utf-8");
    lines.push("");
    lines.push(email.body_plain || email.body || "(No content)");

    return lines.join("\r\n");
  }

  /**
   * Create text message content
   * @private
   */
  private _createTextContent(text: Communication): string {
    const lines: string[] = [];

    lines.push("=== TEXT MESSAGE ===");
    lines.push(`From: ${text.sender || "Unknown"}`);
    lines.push(`To: ${text.recipients || "Unknown"}`);
    lines.push(
      `Date: ${text.sent_at ? new Date(text.sent_at as string).toLocaleString() : "Unknown"}`,
    );
    lines.push("");
    lines.push(text.body_plain || text.body || "(No content)");

    return lines.join("\n");
  }

  /**
   * Create summary file
   * @private
   */
  private _createSummary(
    transaction: Transaction,
    communications: Communication[],
  ): string {
    const lines: string[] = [];

    lines.push("========================================");
    lines.push("  TRANSACTION EXPORT SUMMARY");
    lines.push("========================================");
    lines.push("");
    lines.push(`Property Address: ${transaction.property_address}`);
    lines.push(`Transaction Type: ${transaction.transaction_type || "N/A"}`);
    lines.push(`Status: ${transaction.status || "N/A"}`);
    lines.push("");
    lines.push(
      `Representation Start Date: ${
        transaction.started_at
          ? new Date(transaction.started_at).toLocaleDateString()
          : "N/A"
      }`,
    );
    lines.push(
      `Closing Date: ${
        transaction.closed_at
          ? new Date(transaction.closed_at).toLocaleDateString()
          : "N/A"
      }`,
    );
    lines.push("");
    lines.push(
      `Sale Price: ${
        transaction.sale_price
          ? new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(transaction.sale_price)
          : "N/A"
      }`,
    );
    lines.push("");
    lines.push(`Total Communications Exported: ${communications.length}`);
    lines.push(
      `  - Emails: ${
        communications.filter((c) => isEmailMessage(c)).length
      }`,
    );
    lines.push(
      `  - Texts: ${
        communications.filter((c) => isTextMessage(c)).length
      }`,
    );
    lines.push("");
    lines.push(`Export Date: ${new Date().toLocaleString()}`);
    lines.push("");
    lines.push("========================================");

    return lines.join("\n");
  }

}

export default new EnhancedExportService();
