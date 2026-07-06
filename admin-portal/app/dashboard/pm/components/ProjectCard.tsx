'use client';

/**
 * ProjectCard - PM Module
 *
 * Card representation of a single project showing name, description,
 * status, item count, sprint count, and a progress bar placeholder.
 * Navigates to the project detail page on click.
 */

import Link from 'next/link';
import { FolderKanban, ListChecks, Calendar } from 'lucide-react';
import type { PmProject } from '@/lib/pm-types';

interface ProjectCardProps {
  project: PmProject;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const itemCount = project.item_count ?? 0;
  const sprintCount = project.active_sprint_count ?? 0;

  return (
    <Link href={`/dashboard/pm/projects/${project.id}`}>
      <div className="bg-white border border-gray-200 rounded-lg p-4 hover:border-primary-300 hover:shadow-sm transition-all cursor-pointer">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="p-2 bg-primary-50 rounded-lg">
            <FolderKanban className="h-5 w-5 text-primary-600" />
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
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
              project.status === 'active'
                ? 'bg-green-100 text-green-800'
                : project.status === 'on_hold'
                ? 'bg-yellow-100 text-yellow-800'
                : project.status === 'completed'
                ? 'bg-blue-100 text-blue-800'
                : 'bg-gray-100 text-gray-500'
            }`}
          >
            {project.status === 'active' ? 'Active' : project.status === 'on_hold' ? 'On Hold' : project.status === 'completed' ? 'Completed' : 'Archived'}
          </span>
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
        </div>

        {/* Progress bar removed: the project list RPC does not return
            per-status item counts, so there is no data to compute a real
            completion percentage. Re-add once pm_list_projects returns
            completed_item_count. */}
      </div>
    </Link>
  );
}
