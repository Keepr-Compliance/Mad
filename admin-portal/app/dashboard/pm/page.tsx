/**
 * PM Dashboard - Landing Page
 *
 * Overview page showing aggregate stats, quick navigation links,
 * and recent activity for the Project Management module.
 */

import Link from 'next/link';
import {
  ListChecks,
  KanbanSquare,
  Calendar,
  UserCheck,
  FolderKanban,
} from 'lucide-react';
import { PageHeader } from '@keepr/design-system';
import { TaskStatsCards } from './components/TaskStatsCards';
import { RecentActivityFeed } from './components/RecentActivityFeed';

// ---------------------------------------------------------------------------
// Quick Links configuration
// ---------------------------------------------------------------------------

const quickLinks = [
  {
    label: 'Backlog',
    description: 'Browse and manage all work items',
    href: '/dashboard/pm/backlog',
    icon: ListChecks,
    ready: true,
  },
  {
    label: 'Board',
    description: 'Kanban board view',
    href: '/dashboard/pm/board',
    icon: KanbanSquare,
    ready: true,
  },
  {
    label: 'Sprints',
    description: 'Sprint planning and tracking',
    href: '/dashboard/pm/sprints',
    icon: Calendar,
    ready: true,
  },
  {
    label: 'My Tasks',
    description: 'Items assigned to you',
    href: '/dashboard/pm/my-tasks',
    icon: UserCheck,
    ready: true,
  },
  {
    label: 'Projects',
    description: 'Manage project groupings',
    href: '/dashboard/pm/projects',
    icon: FolderKanban,
    ready: true,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PmDashboardPage() {
  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <PageHeader
        title="Project Management"
        subtitle="Overview of backlog items, sprints, and projects"
      />

      {/* Stats Cards */}
      <TaskStatsCards />

      {/* Quick Links Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6 mb-8">
        {quickLinks.map((link) => {
          const Icon = link.icon;
          const inner = (
            <div className="flex items-center gap-3">
              <Icon className="h-5 w-5 text-gray-400" />
              <div>
                <div className="font-medium text-gray-900">
                  {link.label}
                  {!link.ready && (
                    <span className="ml-2 text-xs text-gray-400">
                      (Coming Soon)
                    </span>
                  )}
                </div>
                <div className="text-sm text-gray-500">{link.description}</div>
              </div>
            </div>
          );

          if (!link.ready) {
            return (
              <div
                key={link.href}
                className="block p-4 rounded-lg border border-gray-100 opacity-60 cursor-not-allowed transition-all"
              >
                {inner}
              </div>
            );
          }

          return (
            <Link
              key={link.href}
              href={link.href}
              className="block p-4 rounded-lg border border-gray-200 hover:border-primary-300 hover:shadow-sm transition-all"
            >
              {inner}
            </Link>
          );
        })}
      </div>

      {/* Recent Activity */}
      <RecentActivityFeed />
    </div>
  );
}
