/**
 * SupportTicketDialog Component
 * TASK-2180: Desktop In-App Support Ticket Dialog with Diagnostics
 * TASK-2282: Added name/email fields for unauthenticated users
 *
 * Full-featured support ticket creation modal with:
 * - Subject, description, priority, category fields
 * - Auto-filled requester info from session (when authenticated)
 * - Name/email input fields (when unauthenticated)
 * - Screenshot capture via desktopCapturer
 * - Collapsible diagnostics preview
 * - Submission to support platform via Supabase RPC
 */

import React, { useState, useEffect, useRef } from "react";
import { ResponsiveModal } from "../common/ResponsiveModal";
import {
  useSupportTicket,
  type TicketPriority,
  type TicketFormData,
} from "../../hooks/useSupportTicket";
import { DiagnosticsPreview } from "./DiagnosticsPreview";
import { ScreenshotCapture } from "./ScreenshotCapture";

interface SupportTicketDialogProps {
  /** Close the dialog */
  onClose: () => void;
  /** User email from session (empty string when unauthenticated) */
  userEmail: string;
  /** User display name from session (empty string when unauthenticated) */
  userName: string;
  /** Auto-capture a screenshot when the dialog opens (used by the floating widget) */
  autoCaptureScreenshot?: boolean;
  /** Pre-captured screenshot (base64) taken before the dialog opened */
  initialScreenshot?: string | null;
  /** TASK-2319: Pre-fill the subject field (used when opened programmatically) */
  prefilledSubject?: string;
  /** BACKLOG-1905: Pre-fill the description field (e.g. an auto-update failure summary) */
  prefilledDescription?: string;
}

const PRIORITY_OPTIONS: Array<{ value: TicketPriority; label: string }> = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

/**
 * Support ticket creation dialog.
 * Opens as a modal overlay. Collects diagnostics on mount.
 */
export function SupportTicketDialog({
  onClose,
  userEmail,
  userName,
  autoCaptureScreenshot = false,
  initialScreenshot = null,
  prefilledSubject = "",
  prefilledDescription = "",
}: SupportTicketDialogProps): React.ReactElement {
  const {
    diagnostics,
    diagnosticsLoading,
    screenshot,
    screenshotLoading,
    categories,
    submitting,
    ticketNumber,
    error,
    success,
    collectDiagnostics,
    captureScreenshot,
    removeScreenshot,
    submitTicket,
    reset,
  } = useSupportTicket(initialScreenshot);

  const [subject, setSubject] = useState(prefilledSubject);
  const [description, setDescription] = useState(prefilledDescription);
  const [priority, setPriority] = useState<TicketPriority>("normal");
  const [categoryId, setCategoryId] = useState<string | null>(null);

  // Name/email form fields — pre-filled when user info is available, always editable
  const [formName, setFormName] = useState(userName || "");
  const [formEmail, setFormEmail] = useState(userEmail || "");
  // BACKLOG-1607: Track whether user has manually edited name/email fields.
  // When false, we accept late-arriving prop values (async user detection).
  // When true, we preserve the user's manual edits over prop updates.
  const nameEditedByUser = useRef(false);
  const emailEditedByUser = useRef(false);

  // Update form fields if user info becomes available after mount
  // (e.g., async IPC detection completes after dialog is already open)
  useEffect(() => {
    if (userName && !nameEditedByUser.current) setFormName(userName);
    if (userEmail && !emailEditedByUser.current) setFormEmail(userEmail);
  }, [userName, userEmail]);

  // Collect diagnostics when dialog opens
  useEffect(() => {
    collectDiagnostics();
  }, [collectDiagnostics]);

  // If a pre-captured screenshot was provided, skip auto-capture.
  // Otherwise fall back to capturing now (which will show the dialog — legacy).
  useEffect(() => {
    if (initialScreenshot) return;
    if (autoCaptureScreenshot) {
      captureScreenshot();
    }
  }, [autoCaptureScreenshot, initialScreenshot, captureScreenshot]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!subject.trim() || !description.trim()) return;

    const effectiveName = formName.trim();
    const effectiveEmail = formEmail.trim();

    if (!effectiveName || !effectiveEmail) return;

    const form: TicketFormData = {
      subject: subject.trim(),
      description: description.trim(),
      priority,
      category_id: categoryId,
    };

    await submitTicket(form, effectiveEmail, effectiveName);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // Success state
  if (success) {
    return (
      <ResponsiveModal onClose={handleClose} zIndex="z-[70]" panelClassName="max-w-lg">
          <div className="p-8 text-center">
            <div className="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mb-4">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-8 w-8 text-green-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Ticket Submitted
            </h3>
            {ticketNumber && (
              <p className="text-sm text-gray-600 mb-1">
                Ticket #{ticketNumber}
              </p>
            )}
            <p className="text-sm text-gray-500 mb-6">
              We&apos;ll get back to you as soon as possible. You&apos;ll receive a response
              via email.
            </p>
            <button
              onClick={handleClose}
              className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2.5 px-4 rounded-lg transition-all"
            >
              Done
            </button>
          </div>
      </ResponsiveModal>
    );
  }

  // Top-level categories only (no parent_id)
  const topCategories = categories.filter((c) => !c.parent_id);

  return (
    <ResponsiveModal onClose={handleClose} zIndex="z-[70]" panelClassName="max-w-lg sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-indigo-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
          {/* Mobile */}
          <div className="sm:hidden flex items-center justify-between">
            <button
              onClick={handleClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back
            </button>
            <h2 className="text-lg font-bold text-white">Support</h2>
          </div>
          {/* Desktop */}
          <div className="hidden sm:flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">Contact Support</h2>
              <p className="text-blue-100 text-sm">
                Describe your issue and we&apos;ll help you out
              </p>
            </div>
            <button
              onClick={handleClose}
              className="text-white hover:text-blue-200 transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <form
          onSubmit={handleSubmit}
          className="flex-1 overflow-y-auto p-6 space-y-4"
        >
          {/* Name and Email fields — always shown, pre-filled when user info available */}
          {(
            <>
              <div>
                <label
                  htmlFor="support-name"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Your Name <span className="text-red-500">*</span>
                </label>
                <input
                  id="support-name"
                  type="text"
                  value={formName}
                  onChange={(e) => { nameEditedByUser.current = true; setFormName(e.target.value); }}
                  placeholder="Your name"
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none min-h-[44px]"
                  required
                  maxLength={100}
                />
              </div>
              <div>
                <label
                  htmlFor="support-email"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Your Email <span className="text-red-500">*</span>
                </label>
                <input
                  id="support-email"
                  type="email"
                  value={formEmail}
                  onChange={(e) => { emailEditedByUser.current = true; setFormEmail(e.target.value); }}
                  placeholder="Your email address"
                  className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none min-h-[44px]"
                  required
                  maxLength={200}
                />
              </div>
            </>
          )}

          {/* Subject */}
          <div>
            <label
              htmlFor="support-subject"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Subject <span className="text-red-500">*</span>
            </label>
            <input
              id="support-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Brief summary of your issue"
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none min-h-[44px]"
              required
              maxLength={200}
            />
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="support-description"
              className="block text-sm font-medium text-gray-700 mb-1"
            >
              Description <span className="text-red-500">*</span>
            </label>
            <textarea
              id="support-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Please describe the issue in detail. What were you trying to do? What happened instead?"
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none"
              rows={4}
              required
              maxLength={5000}
            />
          </div>

          {/* Priority & Category row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="support-priority"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Priority
              </label>
              <select
                id="support-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as TicketPriority)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none min-h-[44px]"
              >
                {PRIORITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="support-category"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Category
              </label>
              <select
                id="support-category"
                value={categoryId || ""}
                onChange={(e) =>
                  setCategoryId(e.target.value || null)
                }
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none min-h-[44px]"
              >
                <option value="">Select category...</option>
                {topCategories.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Screenshot */}
          <ScreenshotCapture
            screenshot={screenshot}
            loading={screenshotLoading}
            onCapture={captureScreenshot}
            onRemove={removeScreenshot}
          />

          {/* Diagnostics */}
          <DiagnosticsPreview
            diagnostics={diagnostics}
            loading={diagnosticsLoading}
          />

          {/* Error */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-700">{typeof error === 'string' ? error : String(error)}</p>
            </div>
          )}
        </form>

        {/* Footer */}
        <div className="flex-shrink-0 bg-gray-50 px-6 py-4 border-t border-gray-200 rounded-b-xl flex gap-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || diagnosticsLoading || !subject.trim() || !description.trim() || !formName.trim() || !formEmail.trim()}
            className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <svg
                  className="animate-spin h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Submitting...
              </>
            ) : (
              "Submit Ticket"
            )}
          </button>
        </div>
    </ResponsiveModal>
  );
}
