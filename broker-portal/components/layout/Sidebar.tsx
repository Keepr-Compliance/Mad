'use client';

/**
 * Sidebar Navigation - Broker Portal
 *
 * Dark collapsible left sidebar following the shared Keepr design system
 * (see packages/design-system/DESIGN-SYSTEM.md, "Chrome recipes").
 *
 * Navigation is role-gated exactly as the previous top-nav was (BACKLOG-907):
 * - During impersonation, only the target-user nav (Dashboard/Submissions/
 *   Support) is shown so the admin sees what the target user sees.
 * - Users/Settings appear for admin and it_admin only, never during
 *   impersonation. it_admin sees ONLY Users/Settings.
 *
 * BACKLOG-3078 adds a third bucket. My Account is personal, not org policy, so
 * it shows for EVERY role and during impersonation — support reads a customer's
 * account page through that flow. It could not be added to either existing
 * bucket: it_admin never sees memberNavItems, and a broker never sees
 * adminNavItems, so either home would hide it from somebody who owns the data.
 *
 * BACKLOG-3474 adds Checklists for broker/admin/it_admin, after Users (founder,
 * 2026-09-24). The layout decides `showChecklists` from lib/checklist-access.ts.
 * Users is in the admin bucket, which only admin and it_admin see, so the entry
 * is inserted right after Users there. A broker has no admin bucket; it gets the
 * entry through a second branch at the end of the member items — the slot Users
 * would take. Hidden during impersonation.
 *
 * BACKLOG-3080 adds the floor bucket for everyone who is not a full-portal user
 * (a brokerage agent, the owner of a personal organization): Dashboard and
 * Support, then My Account. The layout decides `floorOnly` from the shared
 * portal classifier. The other buckets are unchanged.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Files,
  Headphones,
  LayoutDashboard,
  LogOut,
  Settings,
  UserCircle,
  Users,
} from 'lucide-react';
import { AppMark, Wordmark } from '@keepr/ui';
import { resolveViewerName } from '@/lib/utils/userDisplay';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const memberNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Submissions', href: '/dashboard/submissions', icon: Files },
  { label: 'Support', href: '/dashboard/support', icon: Headphones },
];

const adminNavItems: NavItem[] = [
  { label: 'Users', href: '/dashboard/users', icon: Users },
  // Founder, 2026-09-04: the tab named setting should say Org Settings.
  // Since BACKLOG-3078 this route holds ONLY org policy — a person's own
  // settings live at /dashboard/account — so the bare word named the wrong
  // half of the split. Label only; the href is unchanged.
  { label: 'Org Settings', href: '/dashboard/settings', icon: Settings },
];

/** BACKLOG-3080: the floor. No brokerage data, so no Submissions. */
const floorNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Support', href: '/dashboard/support', icon: Headphones },
];

const checklistsNavItem: NavItem = { label: 'Checklists', href: '/dashboard/checklists', icon: ClipboardCheck };

/** A copy of `items` with `item` placed right after the entry with `href`. */
export function insertAfter(items: NavItem[], href: string, item: NavItem): NavItem[] {
  const i = items.findIndex((x) => x.href === href);
  return i < 0 ? [...items, item] : [...items.slice(0, i + 1), item, ...items.slice(i + 1)];
}

/** Personal, not org policy. Shown to every role, impersonation included. */
const personalNavItems: NavItem[] = [
  { label: 'My Account', href: '/dashboard/account', icon: UserCircle },
];

function formatRole(role?: string): string {
  if (!role) return 'Member';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** organization_members.role of the signed-in user (undefined when impersonating). */
  role?: string;
  isImpersonating: boolean;
  displayName?: string;
  displayEmail: string;
  /** Role label shown in the footer; hidden during impersonation. */
  displayRole?: string;
  /** BACKLOG-3474: the caller passes lib/checklist-access.ts (layout.tsx). */
  showChecklists?: boolean;
  /** BACKLOG-3080: not a full-portal user; show the floor bucket only. */
  floorOnly?: boolean;
}

export function Sidebar({
  collapsed,
  onToggle,
  role,
  isImpersonating,
  displayName,
  displayEmail,
  displayRole,
  showChecklists = false,
  floorOnly = false,
}: SidebarProps) {
  const pathname = usePathname();

  // BACKLOG-3080: the floor replaces the member and admin buckets entirely.
  const showFloorNav = floorOnly && !isImpersonating;

  // BACKLOG-907: preserve the exact nav gating of the previous top-nav.
  const showMemberNav = !showFloorNav && (isImpersonating || role !== 'it_admin');
  const showAdminNav =
    !showFloorNav && !isImpersonating && (role === 'admin' || role === 'it_admin');
  const showChecklistsEntry = showChecklists && !isImpersonating;
  const adminItems = showChecklistsEntry
    ? insertAfter(adminNavItems, '/dashboard/users', checklistsNavItem)
    : adminNavItems;

  // BACKLOG-3077: shared resolution — the dashboard header names the same person.
  const name = resolveViewerName({ displayName, displayEmail }) || 'User';
  const initial = name.charAt(0).toUpperCase();

  /** '/dashboard' is a prefix of every route, so it matches exactly only. */
  const exactMatchPaths = new Set(['/dashboard']);

  const renderNavItem = (item: NavItem) => {
    const isActive = exactMatchPaths.has(item.href)
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);
    const Icon = item.icon;

    return (
      <Link
        key={item.href}
        href={item.href}
        className={`flex items-center rounded-md text-sm font-medium transition-colors ${
          collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
        } ${
          isActive
            ? 'bg-gray-800 text-white'
            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
        }`}
        title={collapsed ? item.label : undefined}
      >
        <Icon className="h-5 w-5 shrink-0" />
        {!collapsed && <span>{item.label}</span>}
      </Link>
    );
  };

  return (
    <aside
      className={`sticky top-0 z-40 h-screen flex flex-col bg-gray-900 text-white transition-all duration-200 ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Logo (toggle lives on the right-edge tab below) */}
      <div
        className={`flex items-center border-b border-gray-800 ${
          collapsed ? 'justify-center px-2 py-5' : 'px-6 py-5'
        }`}
      >
        {collapsed ? (
          <AppMark size={28} title="Keepr" />
        ) : (
          <div className="flex items-center gap-2">
            <Wordmark className="text-xl font-bold" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Broker</span>
          </div>
        )}
      </div>

      {/* Expand/Collapse toggle — a small handle protruding past the right edge */}
      <button
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="absolute top-8 -right-3 z-10 flex h-7 w-6 items-center justify-center rounded-md border border-gray-800 bg-gray-900 text-gray-400 shadow-sm transition-colors hover:text-white hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-600"
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>

      {/* Navigation */}
      <nav className={`flex-1 py-4 space-y-1 overflow-y-auto scrollbar-hide ${collapsed ? 'px-2' : 'px-3'}`}>
        {showFloorNav && floorNavItems.map(renderNavItem)}
        {showMemberNav && memberNavItems.map(renderNavItem)}
        {!showAdminNav && showChecklistsEntry && renderNavItem(checklistsNavItem)}
        {showAdminNav && adminItems.map(renderNavItem)}
        {personalNavItems.map(renderNavItem)}
      </nav>

      {/* User info + Sign Out */}
      <div className={`border-t border-gray-800 ${collapsed ? 'px-2 py-4' : 'px-3 py-4'}`}>
        {!collapsed && (
          <div className="px-3 py-1.5 mb-2">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-full bg-primary-600 flex items-center justify-center text-white text-sm font-medium shrink-0">
                {initial}
              </div>
              <div className="min-w-0">
                <p className="text-sm text-gray-300 truncate leading-tight">{name}</p>
                <p className="text-xs text-gray-500 truncate leading-tight">
                  {isImpersonating ? displayEmail : formatRole(displayRole)}
                </p>
              </div>
            </div>
          </div>
        )}
        <a
          href="/auth/logout"
          className={`flex items-center w-full rounded-md text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white transition-colors ${
            collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
          }`}
          title={collapsed ? 'Sign Out' : undefined}
        >
          <LogOut className="h-5 w-5 shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </a>
      </div>
    </aside>
  );
}
