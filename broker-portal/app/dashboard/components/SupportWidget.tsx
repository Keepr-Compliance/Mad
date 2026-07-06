'use client';

/**
 * SupportWidget - Floating help button with ticket dialog
 *
 * Renders a sticky "?" button at the bottom-left of the page.
 * On click, auto-captures a screenshot of the current page using
 * html2canvas, then opens a dialog with the ticket form.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import { inputClasses } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/client';
import { createTicket, getCategories, buildCategoryTree, uploadAttachment } from '@/lib/support-queries';
import type { TicketPriority, SupportCategory } from '@/lib/support-types';
import { PRIORITY_LABELS } from '@/lib/support-types';
import { FileUpload } from '@/app/support/components/FileUpload';
import type { PendingFile } from '@/app/support/components/FileUpload';
import { useBrowserDiagnostics, BrowserDiagnostics } from '@/app/support/components/BrowserDiagnostics';
import html2canvas from 'html2canvas';

export function SupportWidget() {
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Form state
  const [categories, setCategories] = useState<SupportCategory[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const diagnostics = useBrowserDiagnostics();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);

  const validFiles = files.filter((f) => !f.error);

  // Load categories and auth on first open
  useEffect(() => {
    if (!open) return;
    getCategories().then((cats) => setCategories(buildCategoryTree(cats)));

    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setIsAuthenticated(true);
        setEmail(user.email || '');
        setName(
          user.user_metadata?.full_name ||
          user.user_metadata?.name ||
          user.email ||
          ''
        );
      }
    });
  }, [open]);

  // Screenshot preview URL management
  useEffect(() => {
    if (screenshot) {
      const url = URL.createObjectURL(screenshot);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreviewUrl(null);
  }, [screenshot]);

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const disclaimer = selectedCategory?.metadata?.disclaimer as string | undefined;

  const handleOpen = useCallback(async () => {
    setCapturing(true);
    try {
      const canvas = await html2canvas(document.body, {
        useCORS: true,
        logging: false,
        scale: 1,
        ignoreElements: (el) => el.id === 'support-widget',
      });
      canvas.toBlob((blob) => {
        if (blob) {
          setScreenshot(new File([blob], `screenshot-${Date.now()}.png`, { type: 'image/png' }));
        }
        setCapturing(false);
        setOpen(true);
      }, 'image/png');
    } catch {
      // Screenshot capture failed — open dialog anyway
      setCapturing(false);
      setOpen(true);
    }
  }, []);

  // Listen for external "open-support-widget" events so other components can trigger the dialog
  useEffect(() => {
    const handler = () => { handleOpen(); };
    window.addEventListener('open-support-widget', handler);
    return () => window.removeEventListener('open-support-widget', handler);
  }, [handleOpen]);

  const handleClose = useCallback(() => {
    setOpen(false);
    setError(null);
    setSuccess(false);
    setUploadProgress(null);
  }, []);

  const resetForm = useCallback(() => {
    setSubject('');
    setDescription('');
    setPriority('normal');
    setCategoryId('');
    setSubcategoryId('');
    setFiles([]);
    setScreenshot(null);
    setError(null);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;

    if (subject.length < 3) {
      setError('Subject must be at least 3 characters');
      return;
    }
    if (description.length < 3) {
      setError('Description must be at least 3 characters');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setUploadProgress(null);

    try {
      const result = await createTicket({
        subject,
        description,
        priority,
        requester_email: email,
        requester_name: name,
        category_id: categoryId || undefined,
        subcategory_id: subcategoryId || undefined,
      });

      if (validFiles.length > 0) {
        for (let i = 0; i < validFiles.length; i++) {
          setUploadProgress(`Uploading ${i + 1}/${validFiles.length}...`);
          await uploadAttachment(result.id, validFiles[i].file);
        }
      }

      if (diagnostics) {
        try {
          const diagnosticsBlob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
          const diagnosticsFile = new File([diagnosticsBlob], 'browser-diagnostics.json', { type: 'application/json' });
          await uploadAttachment(result.id, diagnosticsFile);
        } catch { /* best-effort */ }
      }

      if (screenshot) {
        try {
          setUploadProgress('Uploading screenshot...');
          await uploadAttachment(result.id, screenshot);
        } catch { /* best-effort */ }
      }

      // Fire-and-forget: send confirmation email to requester.
      // NOTE: Server-side trigger also sends this via send-ticket-confirmation
      // edge function (BACKLOG-1573). This client call is kept as a fallback.
      fetch('/api/email/ticket-confirmation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketNumber: `TKT-${String(result.ticket_number).padStart(4, '0')}`,
          ticketSubject: subject,
          requesterEmail: email,
          ticketLink: `${window.location.origin}/support/${result.id}`,
        }),
      }).catch(() => { /* best-effort */ });

      setSuccess(true);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit ticket');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  return (
    <div id="support-widget">
      {/* Floating "?" button */}
      <button
        onClick={handleOpen}
        disabled={capturing}
        className="fixed bottom-6 left-[calc(var(--sidebar-w,0px)_+_1.5rem)] z-50 w-12 h-12 bg-primary-600 text-white rounded-full shadow-lg hover:bg-primary-700 transition-all hover:scale-105 flex items-center justify-center text-xl font-bold focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-70"
        title="Contact Support"
        aria-label="Contact Support"
      >
        {capturing ? <Loader2 className="animate-spin h-5 w-5" /> : '?'}
      </button>

      {/* Dialog overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-start sm:pl-[calc(var(--sidebar-w,0px)_+_1.5rem)] pb-24 sm:pb-6">
          {/* Backdrop */}
          <div className="fixed inset-0 bg-black/50" onClick={handleClose} />

          {/* Dialog */}
          <div className="relative bg-white rounded-lg shadow-xl border border-gray-200 w-full max-w-md max-h-[80vh] overflow-y-auto sm:ml-0 mx-4 flex flex-col">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-gray-200 px-5 py-4 rounded-t-lg flex items-center justify-between z-10">
              <h2 className="text-lg font-semibold text-gray-900">Contact Support</h2>
              <button
                onClick={handleClose}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Form — always mounted to preserve dialog size */}
            <div className="relative flex-1">
              {/* Success overlay */}
              {success && (
                <div className="absolute inset-0 z-10 bg-white flex flex-col items-center justify-center rounded-b-lg p-5 text-center">
                  <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <Check className="w-6 h-6 text-green-600" />
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">Ticket Submitted</h3>
                  <p className="text-sm text-gray-500 mb-4">We&apos;ll get back to you as soon as possible.</p>
                  <button
                    onClick={handleClose}
                    className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2"
                  >
                    Close
                  </button>
                </div>
              )}

              {/* Form */}
              <form onSubmit={handleSubmit} className={`p-5 space-y-4 ${success ? 'invisible' : ''}`}>
                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-md p-3">
                    <p className="text-sm text-red-700">{error}</p>
                  </div>
                )}

                {/* Name & Email */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="widget-name" className="block text-sm font-medium text-gray-700 mb-1">
                      Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="widget-name"
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      readOnly={isAuthenticated}
                      className={`${inputClasses} read-only:bg-gray-50 read-only:text-gray-500`}
                      placeholder="Your name"
                    />
                  </div>
                  <div>
                    <label htmlFor="widget-email" className="block text-sm font-medium text-gray-700 mb-1">
                      Email <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="widget-email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      readOnly={isAuthenticated}
                      className={`${inputClasses} read-only:bg-gray-50 read-only:text-gray-500`}
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                {/* Category & Priority */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="widget-category" className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                    <select
                      id="widget-category"
                      value={categoryId}
                      onChange={(e) => { setCategoryId(e.target.value); setSubcategoryId(''); }}
                      className={inputClasses}
                    >
                      <option value="">Select...</option>
                      {categories.map((cat) => (
                        <option key={cat.id} value={cat.id}>{cat.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="widget-priority" className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                    <select
                      id="widget-priority"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as TicketPriority)}
                      className={inputClasses}
                    >
                      {(Object.entries(PRIORITY_LABELS) as [TicketPriority, string][]).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Subcategory */}
                {selectedCategory?.children && selectedCategory.children.length > 0 && (
                  <div>
                    <label htmlFor="widget-subcategory" className="block text-sm font-medium text-gray-700 mb-1">Subcategory</label>
                    <select
                      id="widget-subcategory"
                      value={subcategoryId}
                      onChange={(e) => setSubcategoryId(e.target.value)}
                      className={inputClasses}
                    >
                      <option value="">Select...</option>
                      {selectedCategory.children.map((sub) => (
                        <option key={sub.id} value={sub.id}>{sub.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {disclaimer && (
                  <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
                    <p className="text-xs text-amber-800">{disclaimer}</p>
                  </div>
                )}

                {/* Subject */}
                <div>
                  <label htmlFor="widget-subject" className="block text-sm font-medium text-gray-700 mb-1">
                    Subject <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="widget-subject"
                    type="text"
                    required
                    minLength={3}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className={inputClasses}
                    placeholder="Brief summary of your issue"
                  />
                </div>

                {/* Description */}
                <div>
                  <label htmlFor="widget-description" className="block text-sm font-medium text-gray-700 mb-1">
                    Description <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    id="widget-description"
                    required
                    minLength={3}
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className={`${inputClasses} resize-none`}
                    placeholder="Describe your issue..."
                  />
                </div>

                {/* File Attachments */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Attachments</label>
                  <FileUpload files={files} onFilesChange={setFiles} disabled={submitting} />
                </div>

                {/* Auto-captured screenshot (shown as attachment) */}
                {previewUrl && screenshot && (
                  <div className="space-y-1">
                    <label className="block text-xs font-medium text-gray-500">Page Screenshot (auto-captured)</label>
                    <div className="relative inline-block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={previewUrl}
                        alt="Page screenshot"
                        className="max-h-28 rounded-md border border-gray-200"
                      />
                      <button
                        type="button"
                        onClick={() => setScreenshot(null)}
                        disabled={submitting}
                        className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 disabled:opacity-50"
                        aria-label="Remove screenshot"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Diagnostics */}
                <BrowserDiagnostics diagnostics={diagnostics} />

                {uploadProgress && (
                  <div className="text-sm text-primary-600">{uploadProgress}</div>
                )}

                {/* Submit */}
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full px-4 py-2.5 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {submitting ? (uploadProgress || 'Submitting...') : 'Submit Ticket'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
