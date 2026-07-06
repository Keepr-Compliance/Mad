'use client';

/**
 * CreateSprintDialog - PM Module
 *
 * Modal dialog for creating new sprints.
 * Fields: name (required), goal, start date, end date.
 *
 * Pattern: Follows CreateTaskDialog.tsx conventions.
 */

import { useState, useCallback } from 'react';
import { X } from 'lucide-react';
import { Button, Label } from '@keepr/design-system';
import { createSprint } from '@/lib/pm-queries';

interface CreateSprintDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Called after the sprint was successfully created. Receives the newly
   * created sprint's id so callers can auto-assign items, navigate, or
   * update UI state without racing a re-list (BACKLOG-1668).
   */
  onCreated: (newSprintId: string) => void;
}

const INPUT_CLASS =
  'w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export function CreateSprintDialog({
  open,
  onClose,
  onCreated,
}: CreateSprintDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const resetForm = useCallback(() => {
    setName('');
    setGoal('');
    setStartDate('');
    setEndDate('');
    setError(null);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const created = await createSprint(
        name,
        goal || null,
        null, // projectId
        startDate || null,
        endDate || null
      );
      resetForm();
      onCreated(created.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create sprint');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Create Sprint</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Name */}
          <div>
            <Label required>Name</Label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={INPUT_CLASS}
              placeholder="e.g. Sprint 42"
              autoFocus
            />
          </div>

          {/* Goal */}
          <div>
            <Label>Goal</Label>
            <textarea
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className={`${INPUT_CLASS} resize-none`}
              placeholder="What should this sprint achieve? (optional)"
            />
          </div>

          {/* Start Date + End Date row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start Date</Label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <Label>End Date</Label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating...' : 'Create Sprint'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
