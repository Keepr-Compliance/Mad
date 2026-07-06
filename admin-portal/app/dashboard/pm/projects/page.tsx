'use client';

/**
 * Project List Page - /dashboard/pm/projects
 *
 * Displays all projects in a grid of ProjectCards.
 * Provides a "Create Project" button that opens a simple dialog.
 * Fetches data via pm_list_projects RPC.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, X } from 'lucide-react';
import { Button } from '@keepr/design-system';
import { listProjects, createProject } from '@/lib/pm-queries';
import { ProjectList } from '../components/ProjectList';
import type { PmProject } from '@/lib/pm-types';

type StatusFilter = 'all' | 'active' | 'on_hold' | 'completed' | 'archived';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listProjects();
      setProjects(data);
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard/pm"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
            <p className="text-sm text-gray-500 mt-1">
              {loading ? '...' : `${projects.length} projects`}
            </p>
          </div>
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            Create Project
          </Button>
        </div>
      </div>

      {/* Filter Tabs */}
      <ProjectFilterTabs
        projects={projects}
        statusFilter={statusFilter}
        onFilterChange={setStatusFilter}
      />

      {/* Project Grid */}
      <ProjectList
        projects={statusFilter === 'all' ? projects : projects.filter((p) => p.status === statusFilter)}
        loading={loading}
      />

      {/* Create Project Dialog */}
      {showCreate && (
        <CreateProjectDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            loadProjects();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter Tabs (extracted from IIFE in JSX for readability)
// ---------------------------------------------------------------------------

const FILTER_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'on_hold', label: 'On Hold' },
  { key: 'completed', label: 'Completed' },
  { key: 'archived', label: 'Archived' },
];

function ProjectFilterTabs({
  projects,
  statusFilter,
  onFilterChange,
}: {
  projects: PmProject[];
  statusFilter: StatusFilter;
  onFilterChange: (filter: StatusFilter) => void;
}) {
  return (
    <div className="flex items-center gap-1 mb-4 border-b border-gray-200">
      {FILTER_TABS.map((tab) => {
        const count = tab.key === 'all'
          ? projects.length
          : projects.filter((p) => p.status === tab.key).length;
        return (
          <button
            key={tab.key}
            onClick={() => onFilterChange(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              statusFilter === tab.key
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs text-gray-400">({count})</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create Project Dialog (inline, simple form)
// ---------------------------------------------------------------------------

function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    setError(null);
    try {
      await createProject(name.trim(), description.trim() || null);
      onCreated();
    } catch (err) {
      console.error('Failed to create project:', err);
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      {/* Dialog */}
      <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Create Project</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="project-name" className="block text-sm font-medium text-gray-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              ref={nameRef}
              id="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q1 Release"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              required
            />
          </div>

          <div>
            <label htmlFor="project-description" className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of the project..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 resize-none"
            />
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || submitting}>
              {submitting ? 'Creating...' : 'Create Project'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
