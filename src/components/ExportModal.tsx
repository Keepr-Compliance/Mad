import React, { useState, useEffect } from "react";
import { ResponsiveModal } from "./common/ResponsiveModal";
import { InfoTooltip } from "./common/InfoTooltip";
import type { Transaction } from "../../electron/types/models";
import { settingsService, transactionService } from '../services';
import logger from '../utils/logger';
import { useFeatureGate } from "../hooks/useFeatureGate";
import { UpgradePrompt } from "./common/UpgradePrompt";
import { isPaywallLockedError } from "../services/entitlementService";
import { ExportUnlockPrompt } from "./paywall/ExportUnlockPrompt";

interface ExportModalProps {
  transaction: Transaction;
  userId: string;
  onClose: () => void;
  onExportComplete: (result: unknown) => void;
}

/**
 * ExportModal Component
 * Enhanced export with date verification, content/format selection
 */
function ExportModal({
  transaction,
  userId,
  onClose,
  onExportComplete,
}: ExportModalProps) {
  const [step, setStep] = useState(1); // 1: Date Verification, 2: Export Options, 3: Exporting, 4: Close Prompt, 5: Success, 6: Unlock Prompt (BACKLOG-2075)

  // BACKLOG-2075: shown when an export attempt hits the per-transaction paywall.
  const [showUnlockPrompt, setShowUnlockPrompt] = useState(false);

  // Start Date (started_at) - when agent began working on transaction
  const [startDate, setStartDate] = useState(
    transaction.started_at
      ? transaction.started_at.split("T")[0]
      : "",
  );

  // Closing Date (closing_deadline) - scheduled/expected closing date
  const [closingDate, setClosingDate] = useState(
    transaction.closing_deadline
      ? transaction.closing_deadline.split("T")[0]
      : "",
  );

  // End Date (closed_at) - when transaction actually ended (for filtering)
  const [endDate, setEndDate] = useState(
    transaction.closed_at
      ? transaction.closed_at.split("T")[0]
      : "",
  );

  const [contentType, setContentType] = useState<"both" | "emails" | "texts">("both");
  const [attachmentType, setAttachmentType] = useState<"all" | "email" | "text" | "none">("all");
  const [exportFormat, setExportFormat] = useState("combined-pdf"); // combined-pdf, folder, pdf, excel, csv, json, txt_eml
  const [emailExportMode, setEmailExportMode] = useState<"thread" | "individual">("thread");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<{
    stage: string;
    current: number;
    total: number;
    message: string;
  } | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  // Feature gate check
  const { isAllowed, loading: featureGateLoading } = useFeatureGate();
  const canExportText = isAllowed("text_export");
  const canExportEmail = isAllowed("email_export");
  const canExport = canExportText || canExportEmail;
  const canAttachEmail = isAllowed("desktop_email_attachments");
  const canAttachText = isAllowed("desktop_text_attachments");

  // Auto-reset attachmentType when format or content changes
  useEffect(() => {
    // Summary PDF doesn't support attachments
    if (exportFormat === "pdf") {
      setAttachmentType("none");
      return;
    }
    // Reset incompatible attachment selections when content changes
    if (contentType === "emails" && attachmentType === "text") setAttachmentType("none");
    if (contentType === "emails" && attachmentType === "all") setAttachmentType("email");
    if (contentType === "texts" && attachmentType === "email") setAttachmentType("none");
    if (contentType === "texts" && attachmentType === "all") setAttachmentType("text");
  }, [exportFormat, contentType, attachmentType]);

  // Formats that are currently implemented
  const implementedFormats = ["pdf", "folder", "combined-pdf"];

  // Load user preferences to set default export options
  useEffect(() => {
    const loadDefaults = async () => {
      if (userId) {
        try {
          const result = await settingsService.getPreferences(userId);
          if (result.success && result.data) {
            const prefs = result.data as {
              export?: {
                defaultFormat?: string;
                emailExportMode?: string;
                contentType?: string;
                attachmentType?: string;
              };
            };
            // Only use saved preference if it's an implemented format
            if (prefs.export?.defaultFormat && implementedFormats.includes(prefs.export.defaultFormat)) {
              setExportFormat(prefs.export.defaultFormat);
            }
            // Load email export mode preference
            if (prefs.export?.emailExportMode === "thread" || prefs.export?.emailExportMode === "individual") {
              setEmailExportMode(prefs.export.emailExportMode);
            }
            // Load content type preference (BACKLOG-1551)
            if (prefs.export?.contentType === "both" || prefs.export?.contentType === "emails" || prefs.export?.contentType === "texts") {
              setContentType(prefs.export.contentType);
            }
            // Load attachment type preference (BACKLOG-1551)
            if (prefs.export?.attachmentType === "all" || prefs.export?.attachmentType === "email" || prefs.export?.attachmentType === "text" || prefs.export?.attachmentType === "none") {
              setAttachmentType(prefs.export.attachmentType);
            }
          }
        } catch (error) {
          logger.error("Failed to load export preferences:", error);
          // If loading fails, keep the defaults
        }
      }
    };

    loadDefaults();
  }, [userId]);

  // Adjust attachmentType default when feature gates finish loading
  useEffect(() => {
    if (!featureGateLoading) {
      if (attachmentType === "all" && (!canAttachEmail || !canAttachText)) {
        // Downgrade to the best available option
        if (canAttachEmail) setAttachmentType("email");
        else if (canAttachText) setAttachmentType("text");
        else setAttachmentType("none");
      } else if (attachmentType === "email" && !canAttachEmail) {
        setAttachmentType(canAttachText ? "text" : "none");
      } else if (attachmentType === "text" && !canAttachText) {
        setAttachmentType(canAttachEmail ? "email" : "none");
      }
    }
  }, [featureGateLoading, canAttachEmail, canAttachText]);

  // Listen for folder export progress events
  useEffect(() => {
    if (exporting && exportFormat === "folder") {
      const cleanup = window.api.onExportFolderProgress((progress) => {
        setExportProgress(progress);
      });
      return cleanup;
    }
  }, [exporting, exportFormat]);

  const handleDateVerification = () => {
    if (!startDate || !endDate) {
      setError("Please provide Start Date and End Date to continue");
      return;
    }
    // Validate end date is after start date
    if (startDate > endDate) {
      setError("End Date must be after Start Date");
      return;
    }
    setError(null);
    setStep(2);
  };

  /**
   * Fire the actual export IPC for the current format. Returns the raw result so
   * the caller can branch on success / PAYWALL_LOCKED (BACKLOG-2075) / other error.
   */
  const runExportCall = async (): Promise<{ success: boolean; path?: string; error?: string }> => {
    if (exportFormat === "folder") {
      // Folder export for a comprehensive audit package.
      return window.api.transactions.exportFolder(transaction.id, {
        includeEmails: contentType === "emails" || contentType === "both",
        includeTexts: contentType === "texts" || contentType === "both",
        includeAttachments: attachmentType !== "none",
        emailExportMode,
        contentType,
        attachmentType,
      });
    }
    // Enhanced export for single-file formats.
    // summaryOnly: true for "pdf" = report + indexes only; "combined-pdf" = full content.
    const actualFormat = exportFormat === "combined-pdf" ? "pdf" : exportFormat;
    const summaryOnly = exportFormat === "pdf";
    return window.api.transactions.exportEnhanced(transaction.id, {
      exportFormat: actualFormat,
      contentType: contentType === "emails" ? "email" : contentType === "texts" ? "text" : "both",
      startDate,
      endDate,
      summaryOnly,
      attachmentType,
    });
  };

  /**
   * Run the export and route the result. On PAYWALL_LOCKED (BACKLOG-2075), open
   * the unlock prompt instead of showing a raw error; the prompt's onUnlocked
   * re-invokes this to proceed into the normal success path.
   */
  const proceedWithExport = async (): Promise<void> => {
    setExporting(true);
    setError(null);
    setExportProgress(null);
    setStep(3);
    try {
      const result = await runExportCall();

      if (result.success) {
        // 'path' (folder export) or 'filePath' (PDF export) response shapes.
        const exportPath = result.path || (result as { filePath?: string }).filePath || null;
        setExportedPath(exportPath);
        // Skip the close prompt if the transaction is already closed.
        setStep(transaction.status === "closed" ? 5 : 4);
        return;
      }

      // BACKLOG-2075: a locked transaction surfaces as PAYWALL_LOCKED. Convert it
      // into an unlock CTA rather than a raw error. Step 6 hosts the prompt.
      if (isPaywallLockedError(result.error)) {
        setShowUnlockPrompt(true);
        setStep(6);
        return;
      }

      setError(result.error || "Export failed");
      setStep(2);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Export failed";
      // Defensive: a thrown PAYWALL_LOCKED (should arrive as a result) still routes to the prompt.
      if (isPaywallLockedError(errorMessage)) {
        setShowUnlockPrompt(true);
        setStep(6);
        return;
      }
      setError(errorMessage);
      setStep(2);
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    setExportProgress(null);
    setStep(3);

    // Update transaction dates first.
    const updateData = {
      started_at: startDate,
      closing_deadline: closingDate || null,
      closed_at: endDate,
      closing_date_verified: 1,
    };
    const updateResult = await transactionService.update(transaction.id, updateData);
    if (!updateResult.success) {
      setError(`Failed to save dates: ${updateResult.error}`);
      setStep(1);
      setExporting(false);
      return;
    }

    // Save export options as defaults if requested (BACKLOG-1551). Non-blocking.
    if (saveAsDefault && userId) {
      try {
        await settingsService.updatePreferences(userId, {
          export: { defaultFormat: exportFormat, emailExportMode, contentType, attachmentType },
        });
      } catch (err) {
        logger.error("Failed to save export defaults:", err);
      }
    }

    await proceedWithExport();
  };

  // Handle closing transaction after export
  const handleCloseTransaction = async (shouldClose: boolean) => {
    if (shouldClose) {
      try {
        await transactionService.update(transaction.id, { status: "closed" });
      } catch (err) {
        logger.error("Failed to close transaction:", err);
        // Continue to success screen even if closing fails
      }
    }
    setStep(5); // Move to success screen
  };

  // Handle opening the exported file in Finder
  const handleOpenInFinder = () => {
    if (exportedPath) {
      window.api.shell.openFolder(exportedPath);
    }
  };

  // Handle final dismissal - call onExportComplete and close
  const handleDismissSuccess = () => {
    onExportComplete({ success: true, path: exportedPath });
  };

  const formatConfidence = (confidence?: number) => {
    if (!confidence) return null;
    if (confidence >= 80)
      return { text: "High", color: "text-green-600 bg-green-50" };
    if (confidence >= 50)
      return { text: "Medium", color: "text-yellow-600 bg-yellow-50" };
    return { text: "Low", color: "text-red-600 bg-red-50" };
  };

  // C6: When feature is gated, render ONLY UpgradePrompt with title and close button
  if (!featureGateLoading && !canExport) {
    return (
      <ResponsiveModal onClose={onClose} zIndex="z-[70]" overlayClassName="bg-black bg-opacity-50" panelClassName="max-w-3xl">
          {/* Header */}
          <div className="bg-gradient-to-r from-purple-500 to-indigo-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
            {/* Mobile */}
            <div className="sm:hidden flex items-center justify-between">
              <button
                onClick={onClose}
                className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                Back
              </button>
              <h3 className="text-lg font-bold text-white">Export</h3>
            </div>
            {/* Desktop */}
            <div className="hidden sm:flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-white">Export Transaction Audit</h3>
                <p className="text-purple-100 text-sm">{transaction.property_address}</p>
              </div>
              <button
                onClick={onClose}
                className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Gated content: only UpgradePrompt */}
          <div className="p-6">
            <UpgradePrompt
              featureName="Export"
              description="Exporting transaction audits is not available on your current plan."
              onDismiss={onClose}
            />
          </div>
      </ResponsiveModal>
    );
  }

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[70]" overlayClassName="bg-black bg-opacity-50" panelClassName="max-w-3xl">
        {/* Header */}
        <div className="bg-gradient-to-r from-purple-500 to-indigo-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
          {/* Mobile */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={onClose}
              disabled={exporting}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm disabled:opacity-50"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <h3 className="text-lg font-bold text-white">Export</h3>
          </div>
          {/* Desktop */}
          <div className="hidden sm:flex items-center justify-between">
            <div>
              <h3 className="text-xl font-bold text-white">Export Transaction Audit</h3>
              <p className="text-purple-100 text-sm">{transaction.property_address}</p>
            </div>
            <button
              onClick={onClose}
              disabled={exporting}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all disabled:opacity-50"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {/* Step 1: Date Verification */}
          {step === 1 && (
            <div className="space-y-6">
              <div>
                <h4 className="text-lg font-semibold text-gray-900 mb-4">
                  Verify Transaction Dates
                </h4>
                <p className="text-sm text-gray-600 mb-6">
                  Communications will be filtered to only include those between
                  Start Date and End Date.
                </p>
              </div>

              <div className="space-y-4">
                {/* Start Date */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Start Date *
                    </label>
                    {transaction.representation_start_confidence &&
                      formatConfidence(
                        transaction.representation_start_confidence,
                      ) && (
                        <span
                          className={`text-xs px-2 py-1 rounded ${formatConfidence(transaction.representation_start_confidence)!.color}`}
                        >
                          Confidence:{" "}
                          {
                            formatConfidence(
                              transaction.representation_start_confidence,
                            )!.text
                          }
                        </span>
                      )}
                  </div>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    When did you sign the representation agreement with the
                    client?
                  </p>
                </div>

                {/* Closing Date (optional) */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      Closing Date
                    </label>
                    {transaction.closing_date_confidence &&
                      formatConfidence(transaction.closing_date_confidence) && (
                        <span
                          className={`text-xs px-2 py-1 rounded ${formatConfidence(transaction.closing_date_confidence)!.color}`}
                        >
                          Confidence:{" "}
                          {
                            formatConfidence(
                              transaction.closing_date_confidence,
                            )!.text
                          }
                        </span>
                      )}
                  </div>
                  <input
                    type="date"
                    value={closingDate}
                    onChange={(e) => setClosingDate(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Scheduled closing date (optional)
                  </p>
                </div>

                {/* End Date */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-gray-700">
                      End Date *
                    </label>
                  </div>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    When did the transaction end? (Used to filter communications)
                  </p>
                </div>
              </div>

              {transaction.first_communication_date &&
                transaction.last_communication_date && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p className="text-sm font-medium text-blue-900 mb-2">
                      Communication Date Range
                    </p>
                    <p className="text-xs text-blue-700">
                      We found communications from{" "}
                      <span className="font-semibold">
                        {new Date(
                          transaction.first_communication_date,
                        ).toLocaleDateString()}
                      </span>{" "}
                      to{" "}
                      <span className="font-semibold">
                        {new Date(
                          transaction.last_communication_date,
                        ).toLocaleDateString()}
                      </span>
                    </p>
                  </div>
                )}
            </div>
          )}

          {/* Step 2: Export Options */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h4 className="text-lg font-semibold text-gray-900 mb-1">
                  Export Options
                </h4>
                <p className="text-sm text-gray-600">
                  Choose your format, content, and attachment preferences.
                </p>
              </div>

              {/* FORMAT section */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Format
                </label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {/* One PDF - Combined export (default) */}
                  <button
                    onClick={() => setExportFormat("combined-pdf")}
                    disabled={!canExportEmail && !canExportText}
                    className={`px-4 py-3 rounded-lg font-medium transition-all text-left ${
                      !canExportEmail && !canExportText
                        ? "bg-gray-50 text-gray-400 cursor-not-allowed border border-gray-200"
                        : exportFormat === "combined-pdf"
                          ? "bg-purple-500 text-white shadow-md"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    <div className="flex items-center">
                      <span className="font-semibold text-sm">One PDF</span>
                      <InfoTooltip text="Summary report + all email threads + all text conversations merged into a single PDF file" />
                    </div>
                    <div className="text-xs opacity-80 mt-0.5">Combined PDF with all content</div>
                  </button>
                  <button
                    onClick={() => setExportFormat("folder")}
                    className={`px-4 py-3 rounded-lg font-medium transition-all text-left ${
                      exportFormat === "folder"
                        ? "bg-purple-500 text-white shadow-md"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    <div className="flex items-center">
                      <span className="font-semibold text-sm">Audit Package</span>
                      <InfoTooltip text="Export as individual files organized in folders" />
                    </div>
                    <div className="text-xs opacity-80 mt-0.5">
                      Folder with individual PDFs
                    </div>
                  </button>
                  <button
                    onClick={() => setExportFormat("pdf")}
                    className={`px-4 py-3 rounded-lg font-medium transition-all text-left ${
                      exportFormat === "pdf"
                        ? "bg-purple-500 text-white shadow-md"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    <div className="flex items-center">
                      <span className="font-semibold text-sm">Summary PDF</span>
                      <InfoTooltip text="Generate a summary report PDF without full message content" />
                    </div>
                    <div className="text-xs opacity-80 mt-0.5">
                      Transaction report only
                    </div>
                  </button>
                </div>
              </div>

              {/* CONTENT section */}
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Content
                </label>
                <div className="flex flex-wrap gap-1.5 sm:gap-2">
                  {(["both", "emails", "texts"] as const).map((value) => {
                    const labels: Record<string, string> = { both: "Both", emails: "Emails Only", texts: "Texts Only" };
                    const tooltips: Record<string, string> = {
                      both: "Export both email threads and text message conversations",
                      emails: "Export only email threads",
                      texts: "Export only text message conversations",
                    };
                    const isDisabled = (value === "emails" && !canExportEmail) || (value === "texts" && !canExportText);
                    return (
                      <button
                        key={value}
                        onClick={() => { if (!isDisabled) setContentType(value); }}
                        disabled={isDisabled}
                        className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                          contentType === value
                            ? "bg-purple-500 text-white shadow-sm"
                            : isDisabled
                              ? "bg-gray-50 text-gray-400 cursor-not-allowed border border-gray-200"
                              : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          {labels[value]}
                          <InfoTooltip text={tooltips[value]} />
                          {isDisabled && (
                            <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Upgrade</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ATTACHMENTS section - grayed out for Summary PDF */}
              <div className={exportFormat === "pdf" ? "opacity-40 pointer-events-none" : ""}>
                <label className="flex items-center text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Attachments
                  <InfoTooltip text="Attachments are exported as separate files in an /attachments folder, not embedded in the PDF." />
                </label>

                <div className="flex flex-wrap gap-1.5 sm:gap-2">
                  {/* All - requires both attachment licenses, and content must be "both" */}
                  <button
                    onClick={() => { if (canAttachEmail && canAttachText && contentType === "both") setAttachmentType("all"); }}
                    disabled={!canAttachEmail || !canAttachText || contentType !== "both"}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      attachmentType === "all"
                        ? "bg-purple-500 text-white shadow-sm"
                        : canAttachEmail && canAttachText && contentType === "both"
                          ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                          : "bg-gray-50 text-gray-400 cursor-not-allowed border border-gray-200"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      All
                      <InfoTooltip text="Include both email and text message attachments" />
                      {(!canAttachEmail || !canAttachText) && (
                        <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Upgrade</span>
                      )}
                    </span>
                  </button>
                  {/* Email attachments only - disabled when content is texts only */}
                  <button
                    onClick={() => { if (canAttachEmail && contentType !== "texts") setAttachmentType("email"); }}
                    disabled={!canAttachEmail || contentType === "texts"}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      attachmentType === "email"
                        ? "bg-purple-500 text-white shadow-sm"
                        : canAttachEmail && contentType !== "texts"
                          ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                          : "bg-gray-50 text-gray-400 cursor-not-allowed border border-gray-200"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      Email only
                      <InfoTooltip text="Include only email attachments (images, documents)" />
                      {!canAttachEmail && (
                        <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Upgrade</span>
                      )}
                    </span>
                  </button>
                  {/* Text attachments only - disabled when content is emails only */}
                  <button
                    onClick={() => { if (canAttachText && contentType !== "emails") setAttachmentType("text"); }}
                    disabled={!canAttachText || contentType === "emails"}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      attachmentType === "text"
                        ? "bg-purple-500 text-white shadow-sm"
                        : canAttachText && contentType !== "emails"
                          ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                          : "bg-gray-50 text-gray-400 cursor-not-allowed border border-gray-200"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      Text only
                      <InfoTooltip text="Include only text message attachments (photos, videos)" />
                      {!canAttachText && (
                        <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">Upgrade</span>
                      )}
                    </span>
                  </button>
                  {/* None - always available */}
                  <button
                    onClick={() => setAttachmentType("none")}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      attachmentType === "none"
                        ? "bg-purple-500 text-white shadow-sm"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      None
                      <InfoTooltip text="Export without any attachments" />
                    </span>
                  </button>
                </div>

                {/* Upgrade note - stays below the buttons, shown conditionally */}
                {(!canAttachEmail || !canAttachText) && (
                  <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-start gap-1.5">
                    <span className="shrink-0 mt-px">&#128274;</span>
                    <span>
                      {!canAttachEmail && !canAttachText
                        ? "Email and Text attachments require add-on licenses. Upgrade to include."
                        : !canAttachEmail
                          ? "Email attachments require the Email Attachments add-on. Upgrade to include."
                          : "Text attachments require the Text Attachments add-on. Upgrade to include."
                      }
                    </span>
                  </p>
                )}

              </div>

              {/* Save as default checkbox (BACKLOG-1551) */}
              <div className="pt-2 border-t border-gray-200">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={saveAsDefault}
                    onChange={(e) => setSaveAsDefault(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                  />
                  <span className="text-sm text-gray-600">Save these options as my default</span>
                </label>
              </div>

              {/* Format info moved to InfoTooltip on One PDF button */}
            </div>
          )}

          {/* Step 3: Exporting */}
          {step === 3 && (
            <div className="py-8 text-center">
              <div className="w-16 h-16 border-4 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <h4 className="text-lg font-semibold text-gray-900 mb-2">
                {exportFormat === "folder" ? "Creating Audit Package..." : exportFormat === "combined-pdf" ? "Creating Combined PDF..." : "Exporting..."}
              </h4>
              <p className="text-sm text-gray-600">
                {exportProgress
                  ? exportProgress.message
                  : "Creating your compliance audit export. This may take a moment."}
              </p>
              {/* Progress bar removed for cleaner UX - spinner and message are sufficient */}
            </div>
          )}

          {/* Step 4: Close Transaction Prompt */}
          {step === 4 && (
            <div className="py-8 text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-gray-900 mb-2">
                Export Complete!
              </h4>
              <p className="text-sm text-gray-600 mb-6">
                Would you like to mark this transaction as closed?
              </p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={() => handleCloseTransaction(false)}
                  className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 transition-all"
                >
                  No, Keep Open
                </button>
                <button
                  onClick={() => handleCloseTransaction(true)}
                  className="px-6 py-2 bg-gradient-to-r from-purple-500 to-indigo-600 text-white rounded-lg font-semibold hover:from-purple-600 hover:to-indigo-700 shadow-md hover:shadow-lg transition-all"
                >
                  Yes, Close Transaction
                </button>
              </div>
            </div>
          )}

          {/* Step 5: Success with Finder Link */}
          {step === 5 && (
            <div className="py-8 text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h4 className="text-lg font-semibold text-gray-900 mb-2">
                Export Complete!
              </h4>
              <p className="text-sm text-gray-600 mb-6">
                Your {exportFormat === "folder" ? "Audit Package" : exportFormat === "combined-pdf" ? "Combined PDF" : "export"} has been saved successfully.
              </p>
              {/* Buttons side by side */}
              <div className="flex justify-center gap-4">
                {exportedPath && (
                  <button
                    onClick={handleOpenInFinder}
                    className="px-6 py-2 bg-gradient-to-r from-purple-500 to-indigo-600 text-white rounded-lg font-semibold hover:from-purple-600 hover:to-indigo-700 shadow-md hover:shadow-lg transition-all inline-flex items-center gap-2"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
                    </svg>
                    Open Audit
                  </button>
                )}
                <button
                  onClick={handleDismissSuccess}
                  className="px-8 py-2 bg-gradient-to-r from-purple-500 to-indigo-600 text-white rounded-lg font-semibold hover:from-purple-600 hover:to-indigo-700 shadow-md hover:shadow-lg transition-all"
                >
                  Done
                </button>
              </div>
            </div>
          )}

          {/* Step 6: Export-unlock prompt (BACKLOG-2075). Shown when an export
              attempt hits the per-transaction paywall. On unlock, re-run export. */}
          {step === 6 && showUnlockPrompt && (
            <ExportUnlockPrompt
              transactionId={transaction.id}
              onUnlocked={() => {
                setShowUnlockPrompt(false);
                void proceedWithExport();
              }}
              onCancel={() => {
                setShowUnlockPrompt(false);
                setStep(2);
              }}
            />
          )}
        </div>

        {/* Footer — desktop: sticky bar, mobile: floating button */}
        {step !== 3 && step !== 4 && step !== 5 && step !== 6 && (
          <>
            {/* Desktop footer */}
            <div className="hidden sm:flex px-6 py-4 bg-gray-50 rounded-b-xl items-center justify-between">
              <button
                onClick={step === 1 ? onClose : () => setStep(1)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all"
              >
                {step === 1 ? "Cancel" : "Back"}
              </button>
              <button
                onClick={step === 1 ? handleDateVerification : handleExport}
                disabled={step === 1 && (!startDate || !endDate)}
                className={`px-6 py-2 rounded-lg font-semibold transition-all ${
                  step === 1 && (!startDate || !endDate)
                    ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                    : "bg-gradient-to-r from-purple-500 to-indigo-600 text-white hover:from-purple-600 hover:to-indigo-700 shadow-md hover:shadow-lg"
                }`}
              >
                {step === 1 ? "Next" : "Export"}
              </button>
            </div>
            {/* Mobile floating button */}
            <button
              onClick={step === 1 ? handleDateVerification : handleExport}
              disabled={step === 1 && (!startDate || !endDate)}
              className={`sm:hidden fixed bottom-4 right-4 z-[71] px-6 py-3 rounded-full font-semibold text-sm shadow-lg transition-all ${
                step === 1 && (!startDate || !endDate)
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-gradient-to-r from-purple-500 to-indigo-600 text-white hover:from-purple-600 hover:to-indigo-700 hover:shadow-xl"
              }`}
            >
              {step === 1 ? "Next →" : "Export"}
            </button>
          </>
        )}
    </ResponsiveModal>
  );
}

export default ExportModal;
