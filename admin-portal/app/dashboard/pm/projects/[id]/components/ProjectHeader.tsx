'use client';

/**
 * ProjectHeader -- Project detail page header section.
 *
 * Contains:
 * - Back link to projects list
 * - Project name (inline editable) with status badge
 * - Project description (inline editable)
 * - Delete button with confirmation dialog
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, FolderKanban, Trash2, ChevronDown, Loader2 } from 'lucide-react';
import type { PmProject, ProjectField, ProjectStatus } from '@/lib/pm-types';
import { PROJECT_STATUS_LABELS, PROJECT_STATUS_COLORS } from '@/lib/pm-types';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import { PERMISSIONS } from '@/lib/permissions';
import { InlineEditText } from '../../../components/InlineEditText';

interface ProjectHeaderProps {
  project: PmProject;
  projectId: string;
  onUpdateField: (field: ProjectField, value: string | null) => Promise<void>;
  onDeleteRequest: () => void;
}

export function ProjectHeader({
  project,
  projectId,
  onUpdateField,
  onDeleteRequest,
}: ProjectHeaderProps) {
  const { hasPermission } = usePermissions();

  return (
    <div className="mb-6">
      <Link
        href="/dashboard/pm/projects"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Projects
      </Link>

      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-blue-50 rounded-lg">
            <FolderKanban className="h-6 w-6 text-blue-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">
                <InlineEditText
                  value={project.name}
                  placeholder="Project name..."
                  onSave={async (newValue) => {
                    if (!newValue) return;
                    await onUpdateField('name', newValue);
                  }}
                  displayClassName="text-2xl font-bold text-gray-900"
                />
              </h1>
              <ProjectStatusDropdown
                status={project.status}
                onChangeStatus={async (newStatus) => {
                  await onUpdateField('status', newStatus);
                }}
              />
            </div>
            <div className="mt-1">
              <InlineEditText
                value={project.description}
                placeholder="Add a description..."
                multiline
                onSave={async (newValue) => {
                  await onUpdateField('description', newValue);
                }}
                displayClassName="text-sm text-gray-500"
                rows={2}
              />
            </div>
          </div>
        </div>
        {hasPermission(PERMISSIONS.PM_ADMIN) && (
          <button
            onClick={onDeleteRequest}
            className="inline-flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 transition-colors shrink-0"
            title="Delete project"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectStatusDropdown -- Clickable status badge with dropdown menu
// ---------------------------------------------------------------------------

const ALL_STATUSES: ProjectStatus[] = ['active', 'on_hold', 'completed', 'archived'];

interface ProjectStatusDropdownProps {
  status: ProjectStatus;
  onChangeStatus: (status: ProjectStatus) => Promise<void>;
}

function ProjectStatusDropdown({ status, onChangeStatus }: ProjectStatusDropdownProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const handleSelect = useCallback(async (newStatus: ProjectStatus) => {
    if (newStatus === status) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onChangeStatus(newStatus);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setSaving(false);
    }
  }, [status, onChangeStatus]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={saving}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium transition-colors hover:ring-2 hover:ring-offset-1 hover:ring-primary-300 ${
          PROJECT_STATUS_COLORS[status]
        } ${saving ? 'opacity-50' : ''}`}
      >
        {saving ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : null}
        {PROJECT_STATUS_LABELS[status]}
        <ChevronDown className="h-3 w-3" />
      </button>

      {error && (
        <div className="absolute top-full left-0 mt-1 z-20 bg-red-50 border border-red-200 rounded px-2 py-1 text-xs text-red-700 whitespace-nowrap">
          {error}
        </div>
      )}

      {open && !saving && (
        <div className="absolute top-full left-0 mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px]">
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => handleSelect(s)}
              className={`w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2 ${
                s === status ? 'font-semibold' : ''
              }`}
            >
              <span
                className={`inline-block w-2 h-2 rounded-full ${
                  PROJECT_STATUS_COLORS[s].split(' ')[0]
                }`}
              />
              {PROJECT_STATUS_LABELS[s]}
              {s === status && <span className="ml-auto text-gray-400">&#10003;</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackLink -- Shared "Back to Projects" link
// ---------------------------------------------------------------------------

export function BackLink() {
  return (
    <Link
      href="/dashboard/pm/projects"
      className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
    >
      <ArrowLeft className="h-4 w-4" />
      Back to Projects
    </Link>
  );
}

// ---------------------------------------------------------------------------
// ProjectLoadingSkeleton -- Shown while project detail is loading
// ---------------------------------------------------------------------------

export function ProjectLoadingSkeleton() {
  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-6">
        <BackLink />
      </div>
      <div className="animate-pulse space-y-6">
        <div className="h-8 bg-gray-200 rounded w-1/3" />
        <div className="h-4 bg-gray-200 rounded w-2/3" />
        <div className="h-32 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProjectNotFound -- Shown when project doesn't exist
// ---------------------------------------------------------------------------

export function ProjectNotFound() {
  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-6">
        <BackLink />
      </div>
      <div className="text-center py-12 text-gray-500">
        <p className="text-sm">Project not found.</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeleteConfirmation -- Inline confirmation banner for project deletion
// ---------------------------------------------------------------------------

interface DeleteConfirmationProps {
  projectName: string;
  deleting: boolean;
  deleteError: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmation({
  projectName,
  deleting,
  deleteError,
  onConfirm,
  onCancel,
}: DeleteConfirmationProps) {
  return (
    <>
      <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
        <p className="text-sm text-red-800">
          Are you sure you want to delete project &quot;{projectName}&quot;? This will soft-delete the project.
        </p>
        <div className="flex gap-2 mt-3">
          <button
            onClick={onConfirm}
            disabled={deleting}
            className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1 text-sm text-gray-700 bg-white border rounded hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
      {deleteError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
          <p className="text-sm text-red-800">{deleteError}</p>
        </div>
      )}
    </>
  );
}
