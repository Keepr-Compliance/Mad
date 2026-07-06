'use client';

/**
 * TicketForm - Customer Ticket Submission
 *
 * Form for submitting a new support ticket with file attachments.
 * Auto-fills name/email if user is authenticated.
 * Works for both authenticated and unauthenticated users.
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Input, Label, Select, Textarea } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/client';
import { createTicket, getCategories, buildCategoryTree, uploadAttachment } from '@/lib/support-queries';
import type { TicketPriority, SupportCategory } from '@/lib/support-types';
import { PRIORITY_LABELS } from '@/lib/support-types';
import { FileUpload } from './FileUpload';
import type { PendingFile } from './FileUpload';
import { useBrowserDiagnostics, BrowserDiagnostics } from './BrowserDiagnostics';

export function TicketForm() {
  const router = useRouter();
  const [categories, setCategories] = useState<SupportCategory[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  // Browser diagnostics (best-effort)
  const diagnostics = useBrowserDiagnostics();

  // Form state
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);

  const validFiles = files.filter((f) => !f.error);

  // Load categories and check auth
  useEffect(() => {
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
  }, []);

  const selectedCategory = categories.find((c) => c.id === categoryId);
  const disclaimer = selectedCategory?.metadata?.disclaimer as string | undefined;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Guard against double submission (React state is async)
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

      // Upload attachments after ticket is created
      if (validFiles.length > 0) {
        for (let i = 0; i < validFiles.length; i++) {
          setUploadProgress(`Uploading ${i + 1}/${validFiles.length}...`);
          await uploadAttachment(result.id, validFiles[i].file);
        }
      }

      // Upload diagnostics as JSON attachment (best-effort)
      if (diagnostics) {
        try {
          const diagnosticsBlob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
          const diagnosticsFile = new File([diagnosticsBlob], 'browser-diagnostics.json', { type: 'application/json' });
          await uploadAttachment(result.id, diagnosticsFile);
        } catch {
          // Diagnostics upload failure should not block ticket submission
        }
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

      router.push('/dashboard/support?success=true');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit ticket');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      setUploadProgress(null);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <Alert variant="error">{error}</Alert>}

      {/* Name & Email */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="name" required>
            Your Name
          </Label>
          <Input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            readOnly={isAuthenticated}
            className={isAuthenticated ? 'bg-gray-50 text-gray-500' : undefined}
            placeholder="John Doe"
          />
        </div>
        <div>
          <Label htmlFor="email" required>
            Email Address
          </Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={isAuthenticated}
            className={isAuthenticated ? 'bg-gray-50 text-gray-500' : undefined}
            placeholder="you@example.com"
          />
        </div>
      </div>

      {/* Category & Priority */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label htmlFor="category">Category</Label>
          <Select
            id="category"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setSubcategoryId('');
            }}
          >
            <option value="">Select a category...</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="priority">Priority</Label>
          <Select
            id="priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TicketPriority)}
          >
            {(Object.entries(PRIORITY_LABELS) as [TicketPriority, string][]).map(
              ([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              )
            )}
          </Select>
        </div>
      </div>

      {/* Subcategory */}
      {selectedCategory?.children && selectedCategory.children.length > 0 && (
        <div>
          <Label htmlFor="subcategory">Subcategory</Label>
          <Select
            id="subcategory"
            value={subcategoryId}
            onChange={(e) => setSubcategoryId(e.target.value)}
          >
            <option value="">Select a subcategory...</option>
            {selectedCategory.children.map((sub) => (
              <option key={sub.id} value={sub.id}>
                {sub.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* Compliance disclaimer */}
      {disclaimer && <Alert variant="warning">{disclaimer}</Alert>}

      {/* Subject */}
      <div>
        <Label htmlFor="subject" required>
          Subject
        </Label>
        <Input
          id="subject"
          type="text"
          required
          minLength={3}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Brief summary of your issue"
        />
      </div>

      {/* Description */}
      <div>
        <Label htmlFor="description" required>
          Description
        </Label>
        <Textarea
          id="description"
          required
          minLength={3}
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Please describe your issue in detail..."
        />
      </div>

      {/* File Attachments */}
      <div>
        <Label>Attachments</Label>
        <FileUpload files={files} onFilesChange={setFiles} disabled={submitting} />
      </div>

      {/* Browser Diagnostics */}
      <BrowserDiagnostics diagnostics={diagnostics} />

      {uploadProgress && (
        <div className="text-sm text-primary-600">{uploadProgress}</div>
      )}

      {/* Submit */}
      <div className="pt-2">
        <Button
          type="submit"
          variant="primary"
          disabled={submitting}
          className="w-full sm:w-auto"
        >
          {submitting ? (uploadProgress || 'Submitting...') : 'Submit Ticket'}
        </Button>
      </div>
    </form>
  );
}
