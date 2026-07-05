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
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Files,
  Headphones,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Users,
} from 'lucide-react';

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
  { label: 'Settings', href: '/dashboard/settings', icon: Settings },
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
  const showAdminNav = !isImpersonating && (role === 'admin' || role === 'it_admin');

  const name = displayName || displayEmail.split('@')[0] || 'User';
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
      className={`sticky top-0 h-screen flex flex-col bg-gray-900 text-white transition-all duration-200 ${
        collapsed ? 'w-16' : 'w-64'
      }`}
    >
      {/* Logo + Toggle */}
      <div
        className={`flex items-center border-b border-gray-800 ${
          collapsed ? 'justify-center px-2 py-5' : 'justify-between px-6 py-5'
        }`}
      >
        {!collapsed && (
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold">Keepr.</span>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Broker</span>
          </div>
        )}
        <button
          onClick={onToggle}
          className="text-gray-400 hover:text-white transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
        </button>
      </div>

      {/* Navigation */}
      <nav className={`flex-1 py-4 space-y-1 overflow-y-auto scrollbar-hide ${collapsed ? 'px-2' : 'px-3'}`}>
        {showMemberNav && memberNavItems.map(renderNavItem)}
        {showAdminNav && adminNavItems.map(renderNavItem)}
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
