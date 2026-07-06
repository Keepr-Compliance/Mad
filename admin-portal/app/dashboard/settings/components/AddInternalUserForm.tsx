'use client';

/**
 * AddInternalUserForm - Dialog to add a new internal user
 *
 * Renders a trigger button that opens a modal dialog with
 * email input + role dropdown. All logic is handled server-side
 * via the /api/internal-users/invite route (BACKLOG-885).
 */

import { useState, useCallback, useEffect, useRef, type FormEvent } from 'react';
import { UserPlus } from 'lucide-react';
import { Button, Input, Select, Label } from '@keepr/design-system';
import type { AdminRole } from '../page';

interface AddInternalUserFormProps {
  onSuccess: () => void;
  roles: AdminRole[];
}

export function AddInternalUserForm({ onSuccess, roles }: AddInternalUserFormProps) {
  const defaultSlug = roles.find(r => r.slug === 'support-agent')?.slug || roles[0]?.slug || '';
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [selectedSlug, setSelectedSlug] = useState(defaultSlug);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDuplicateError, setIsDuplicateError] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const resetForm = useCallback(() => {
    setEmail('');
    setSelectedSlug(defaultSlug);
    setError(null);
    setIsDuplicateError(false);
    setSuccess(null);
    setIsSubmitting(false);
  }, [defaultSlug]);

  const handleOpen = useCallback(() => {
    resetForm();
    setIsOpen(true);
  }, [resetForm]);

  const handleClose = useCallback(() => {
    if (!isSubmitting) {
      setIsOpen(false);
    }
  }, [isSubmitting]);

  // Focus dialog on open
  useEffect(() => {
    if (isOpen) {
      dialogRef.current?.focus();
    }
  }, [isOpen]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isSubmitting) {
        setIsOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsDuplicateError(false);
    setSuccess(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Email is required');
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/internal-users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail, role: selectedSlug }),
      });

      const json = (await response.json()) as {
        success?: boolean;
        pending?: boolean;
        message?: string;
        error?: string;
      };

      if (!response.ok || !json.success) {
        const errMsg = json.error || 'Failed to add user';
        setError(errMsg);
        setIsDuplicateError(response.status === 409);
        return;
      }

      if (json.pending) {
        setSuccess(json.message || `Invitation created for ${trimmedEmail}. Role will be assigned on first login.`);
      } else {
        const roleName = roles.find((r) => r.slug === selectedSlug)?.name || selectedSlug;
        setSuccess(`Successfully added ${trimmedEmail} as ${roleName}`);
      }
      setEmail('');
      setSelectedSlug(defaultSlug);
      onSuccess();
      setTimeout(() => setIsOpen(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      {/* Trigger button */}
      <Button onClick={handleOpen} className="shadow-sm">
        <UserPlus className="h-4 w-4" />
        Add User
      </Button>

      {/* Dialog overlay */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={handleClose}
          />

          {/* Dialog */}
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-user-dialog-title"
            tabIndex={-1}
            className="relative bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 p-6 outline-none"
          >
            <div className="mb-4">
              <h3 id="add-user-dialog-title" className="text-lg font-semibold text-gray-900">
                Add Internal User
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                Add an existing Keepr user by email, or invite a new user to create an account.
              </p>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="add-user-email">Email address</Label>
                  <Input
                    id="add-user-email"
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError(null);
                      setSuccess(null);
                    }}
                    placeholder="user@example.com"
                    disabled={isSubmitting}
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="add-user-role">Role</Label>
                  <Select
                    id="add-user-role"
                    value={selectedSlug}
                    onChange={(e) => setSelectedSlug(e.target.value)}
                    disabled={isSubmitting}
                  >
                    {roles.map((r) => (
                      <option key={r.slug} value={r.slug}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              {/* Status messages */}
              {error && (
                isDuplicateError ? (
                  <div className="mt-4 rounded-md bg-amber-50 border border-amber-200 px-4 py-3">
                    <p className="text-sm text-amber-800">{error}</p>
                    <p className="mt-1 text-xs text-amber-600">
                      You can resend the invitation from the internal users table below.
                    </p>
                  </div>
                ) : (
                  <div className="mt-4 rounded-md bg-red-50 border border-red-200 px-4 py-3">
                    <p className="text-sm text-red-700">{error}</p>
                  </div>
                )
              )}
              {success && (
                <div className="mt-4 rounded-md bg-green-50 border border-green-200 px-4 py-3">
                  <p className="text-sm text-green-700">{success}</p>
                </div>
              )}

              <div className="mt-6 flex justify-end gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleClose}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting} className="shadow-sm">
                  <UserPlus className="h-4 w-4" />
                  {isSubmitting ? 'Adding...' : 'Add User'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
