'use client';

/**
 * ProjectCard - PM Module
 *
 * Card representation of a single project showing name, description,
 * status, item count, sprint count, and a progress bar placeholder.
 * Navigates to the project detail page on click.
 */

import Link from 'next/link';
import { FolderKanban, ListChecks, Calendar, Clock } from 'lucide-react';
import type { PmProject } from '@/lib/pm-types';
import {
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
} from '@/lib/pm-types';

interface ProjectCardProps {
  project: PmProject;
}

/** Whole days since `created_at`; null when created_at is missing/unparseable. */
function computeDaysOpen(createdAt: string | null | undefined): number | null {
  if (!createdAt) return null;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.floor((Date.now() - created) / 86_400_000));
}

export function ProjectCard({ project }: ProjectCardProps) {
  const itemCount = project.item_count ?? 0;
  const sprintCount = project.active_sprint_count ?? 0;
  const daysOpen = computeDaysOpen(project.created_at);

  return (
    <Link href={`/dashboard/pm/projects/${project.id}`}>
      <div className="bg-white border border-gray-200 rounded-lg p-4 hover:border-primary-300 hover:shadow-sm transition-all cursor-pointer">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="p-2 bg-blue-50 rounded-lg">
            <FolderKanban className="h-5 w-5 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 truncate">
              {project.name}
            </h3>
            {project.description && (
              <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                {project.description}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span
              className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${PROJECT_STATUS_COLORS[project.status]}`}
            >
              {PROJECT_STATUS_LABELS[project.status]}
            </span>
            {project.priority && (
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[project.priority]}`}
              >
                {PRIORITY_LABELS[project.priority]}
              </span>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="flex items-center gap-4 mt-4 text-xs text-gray-500">
          <div className="flex items-center gap-1">
            <ListChecks className="h-3.5 w-3.5" />
            <span>{itemCount} items</span>
          </div>
          <div className="flex items-center gap-1">
            <Calendar className="h-3.5 w-3.5" />
            <span>{sprintCount} active sprints</span>
          </div>
          {daysOpen !== null && (
            <div className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              <span>{daysOpen}d open</span>
            </div>
          )}
        </div>

        {/* Progress bar removed: the project list RPC does not return
            per-status item counts, so there is no data to compute a real
            completion percentage. Re-add once pm_list_projects returns
            completed_item_count. */}
      </div>
    </Link>
  );
}
