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
 * - Org Settings is admin/it_admin only, never during impersonation.
 *
 * BACKLOG-3078 adds a third bucket. My Account is personal, not org policy, so
 * it shows for EVERY role and during impersonation — support reads a customer's
 * account page through that flow. It could not be added to either existing
 * bucket: it_admin never sees memberNavItems, and (before BACKLOG-3504) a
 * broker never saw the admin bucket at all, so either home would hide it from
 * somebody who owns the data.
 *
 * BACKLOG-3504 splits what was one "Users + Org Settings" bucket behind one
 * `showAdminNav` boolean into two independent gates. The split editor
 * (BACKLOG-3504) and the narrowed Users/detail page access
 * (BACKLOG-3541, `broker-portal/lib/users-access.ts`'s `USERS_PAGE_ROLES`)
 * both admit broker; Org Settings does not, and never has. Grant exactly
 * what was approved for each: a broker gets a click path to the Users pages
 * their new access already opens, not to org-wide SSO/SCIM/retention policy.
 *
 * NOT importing USERS_PAGE_ROLES from lib/users-access.ts here, even though
 * it is the authoritative list and the obvious way to avoid two roles arrays
 * drifting apart. Tried it, and it breaks `next build`: that module imports
 * `@/lib/supabase/server` (for `checkUsersPageAccess()`), which pulls in
 * `next/headers`, and this component is `'use client'` — the exact hazard
 * `lib/account/accountView.ts`'s header already documents for the identical
 * shape (`getAccountView.ts` vs `accountView.ts`), invisible to tsc and jest
 * and only caught by `next build`. `lib/users-access.ts` has not had that
 * split applied (it is not merged yet — BACKLOG-3541). Until it is, or a
 * client-safe sibling constant exists, this file spells the same three roles
 * inline, matching how `showMemberNav`/`showAdminNav` above were already
 * plain inline booleans rather than imports from a shared list.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
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

/** admin, it_admin, broker (BACKLOG-3504/3541) — gated by showUsersNav. */
const usersNavItems: NavItem[] = [
  { label: 'Users', href: '/dashboard/users', icon: Users },
];

/** admin, it_admin ONLY — gated by showOrgSettingsNav. Never widened
 *  alongside Users: org-wide SSO/SCIM/retention policy is a different grant
 *  than viewing/editing one person's commission split. */
const orgSettingsNavItems: NavItem[] = [
  // Founder, 2026-09-04: the tab named setting should say Org Settings.
  // Since BACKLOG-3078 this route holds ONLY org policy — a person's own
  // settings live at /dashboard/account — so the bare word named the wrong
  // half of the split. Label only; the href is unchanged.
  { label: 'Org Settings', href: '/dashboard/settings', icon: Settings },
];

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
}

export function Sidebar({
  collapsed,
  onToggle,
  role,
  isImpersonating,
  displayName,
  displayEmail,
  displayRole,
}: SidebarProps) {
  const pathname = usePathname();

  // BACKLOG-907: preserve the exact nav gating of the previous top-nav.
  const showMemberNav = isImpersonating || role !== 'it_admin';
  // BACKLOG-3504/3541: split from the single showAdminNav boolean. Users
  // admits broker (matches USERS_PAGE_ROLES in lib/users-access.ts — see the
  // file header for why that is not imported directly here); Org Settings
  // does not, and is otherwise unchanged from before this split.
  const showUsersNav =
    !isImpersonating && (role === 'admin' || role === 'it_admin' || role === 'broker');
  const showOrgSettingsNav = !isImpersonating && (role === 'admin' || role === 'it_admin');

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
        {showMemberNav && memberNavItems.map(renderNavItem)}
        {showUsersNav && usersNavItems.map(renderNavItem)}
        {showOrgSettingsNav && orgSettingsNavItems.map(renderNavItem)}
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
