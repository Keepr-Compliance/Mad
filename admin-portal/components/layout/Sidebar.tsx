'use client';

/**
 * Sidebar Navigation - Admin Portal
 *
 * Left sidebar with navigation items.
 * Items are permission-gated based on the user's RBAC role.
 * Settings-related items are grouped under a collapsible section.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { LayoutDashboard, BarChart3, Users, Building2, CreditCard, Headphones, Inbox, UserCheck, Settings, LogOut, ChevronLeft, FileText, ChevronDown, ChevronRight, Shield, KanbanSquare, ListChecks, FolderKanban, Calendar, Filter } from 'lucide-react';
import { AppMark, Wordmark } from '@keepr/ui';
import { useAuth } from '@/components/providers/AuthProvider';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import type { PermissionKey } from '@/lib/permissions';
import { PERMISSIONS } from '@/lib/permissions';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  permission: PermissionKey;
}

/** Top-level nav items (not grouped) */
const mainNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, permission: PERMISSIONS.DASHBOARD_VIEW },
  { label: 'Analytics', href: '/dashboard/analytics', icon: BarChart3, permission: PERMISSIONS.ANALYTICS_VIEW },
  { label: 'Funnel', href: '/dashboard/funnel', icon: Filter, permission: PERMISSIONS.ANALYTICS_VIEW },
  { label: 'Users', href: '/dashboard/users', icon: Users, permission: PERMISSIONS.USERS_VIEW },
  { label: 'Organizations', href: '/dashboard/organizations', icon: Building2, permission: PERMISSIONS.ORGANIZATIONS_VIEW },
  { label: 'Plans', href: '/dashboard/plans', icon: CreditCard, permission: PERMISSIONS.PLANS_VIEW },
];

/** Sub-items under the collapsible "Support" section */
const supportSubItems: NavItem[] = [
  { label: 'Queue', href: '/dashboard/support', icon: Inbox, permission: PERMISSIONS.SUPPORT_VIEW },
  { label: 'My Tickets', href: '/dashboard/support/my-tickets', icon: UserCheck, permission: PERMISSIONS.SUPPORT_VIEW },
  { label: 'Analytics', href: '/dashboard/support/analytics', icon: BarChart3, permission: PERMISSIONS.SUPPORT_MANAGE },
  { label: 'Settings', href: '/dashboard/support/settings', icon: Settings, permission: PERMISSIONS.SUPPORT_MANAGE },
];

/** Permissions that grant visibility to the Support section */
const supportSectionPermissions: PermissionKey[] = [
  PERMISSIONS.SUPPORT_VIEW,
  PERMISSIONS.SUPPORT_MANAGE,
];

/** Sub-items under the collapsible "Projects" section */
const pmSubItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard/pm', icon: LayoutDashboard, permission: PERMISSIONS.PM_VIEW },
  { label: 'Backlog', href: '/dashboard/pm/backlog', icon: ListChecks, permission: PERMISSIONS.PM_VIEW },
  { label: 'Board', href: '/dashboard/pm/board', icon: KanbanSquare, permission: PERMISSIONS.PM_VIEW },
  { label: 'My Tasks', href: '/dashboard/pm/my-tasks', icon: UserCheck, permission: PERMISSIONS.PM_VIEW },
  { label: 'Sprints', href: '/dashboard/pm/sprints', icon: Calendar, permission: PERMISSIONS.PM_VIEW },
  { label: 'Projects', href: '/dashboard/pm/projects', icon: FolderKanban, permission: PERMISSIONS.PM_MANAGE },
  { label: 'Settings', href: '/dashboard/pm/settings', icon: Settings, permission: PERMISSIONS.PM_ADMIN },
];

/** Permissions that grant visibility to the Projects section */
const pmSectionPermissions: PermissionKey[] = [
  PERMISSIONS.PM_VIEW,
  PERMISSIONS.PM_MANAGE,
];

/** Sub-items under the collapsible "Settings" section */
const settingsSubItems: NavItem[] = [
  { label: 'Internal Users', href: '/dashboard/settings?tab=users', icon: Users, permission: PERMISSIONS.INTERNAL_USERS_VIEW },
  { label: 'Roles & Permissions', href: '/dashboard/settings?tab=roles', icon: Shield, permission: PERMISSIONS.ROLES_VIEW },
  { label: 'Audit Log', href: '/dashboard/settings?tab=audit', icon: FileText, permission: PERMISSIONS.AUDIT_VIEW },
];

/** Permissions that grant visibility to the Settings section */
const settingsSectionPermissions: PermissionKey[] = [
  PERMISSIONS.INTERNAL_USERS_VIEW,
  PERMISSIONS.ROLES_VIEW,
  PERMISSIONS.AUDIT_VIEW,
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user, signOut } = useAuth();
  const { hasPermission, roleName, loading } = usePermissions();

  const displayName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.email ||
    'Admin';
  const avatarUrl = user?.user_metadata?.avatar_url || user?.user_metadata?.picture;

  // Check if any settings sub-item route is active
  const isSettingsActive = pathname.startsWith('/dashboard/settings');

  // Check if any support sub-item route is active
  const isSupportActive = pathname.startsWith('/dashboard/support');

  // Check if any PM sub-item route is active
  const isPmActive = pathname.startsWith('/dashboard/pm');

  // Auto-expand when a settings route is active; allow manual toggle otherwise
  const [settingsExpanded, setSettingsExpanded] = useState(isSettingsActive);
  const [supportExpanded, setSupportExpanded] = useState(isSupportActive);
  const [pmExpanded, setPmExpanded] = useState(isPmActive);

  // Keep expanded state in sync when navigating to/from settings/support routes
  useEffect(() => {
    if (isSettingsActive) {
      setSettingsExpanded(true);
    }
  }, [isSettingsActive]);

  useEffect(() => {
    if (isSupportActive) {
      setSupportExpanded(true);
    }
  }, [isSupportActive]);

  useEffect(() => {
    if (isPmActive) {
      setPmExpanded(true);
    }
  }, [isPmActive]);

  // Whether the user can see the settings/support/pm sections at all
  const canSeeSettings = loading || settingsSectionPermissions.some((p) => hasPermission(p));
  const canSeeSupport = loading || supportSectionPermissions.some((p) => hasPermission(p));
  const canSeePm = loading || pmSectionPermissions.some((p) => hasPermission(p));

  /** Paths that should use exact-match only (prefix of other routes) */
  const exactMatchPaths = new Set(['/dashboard', '/dashboard/support', '/dashboard/pm']);

  const renderNavItem = (item: NavItem, isSubItem = false) => {
    // While permissions are loading, show all items to prevent flash
    if (!loading && !hasPermission(item.permission)) return null;

    const itemPath = item.href.split('?')[0];
    const itemQuery = item.href.includes('?') ? new URLSearchParams(item.href.split('?')[1]) : null;
    let isActive: boolean;

    if (itemQuery) {
      const tabValue = itemQuery.get('tab');
      const currentTab = searchParams.get('tab');
      isActive = pathname === itemPath && currentTab === tabValue;
    } else if (exactMatchPaths.has(item.href)) {
      isActive = pathname === item.href;
    } else {
      isActive = pathname === item.href || pathname.startsWith(item.href);
    }

    const Icon = item.icon;

    return (
      <Link
        key={item.href}
        href={item.href}
        className={`flex items-center rounded-md text-sm font-medium transition-colors ${
          collapsed ? 'justify-center px-2 py-2' : isSubItem ? 'gap-3 pl-9 pr-3 py-2' : 'gap-3 px-3 py-2'
        } ${
          isActive
            ? 'bg-gray-800 text-white'
            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
        }`}
        title={collapsed ? item.label : undefined}
      >
        <Icon className={`shrink-0 ${isSubItem ? 'h-4 w-4' : 'h-5 w-5'}`} />
        {!collapsed && <span>{item.label}</span>}
      </Link>
    );
  };

  return (
    <aside className={`sticky top-0 h-screen flex flex-col bg-gray-900 text-white transition-all duration-200 ${collapsed ? 'w-16' : 'w-64'}`}>
      {/* Logo (toggle lives on the right-edge tab below) */}
      <div className={`flex items-center border-b border-gray-800 ${collapsed ? 'justify-center px-2 py-5' : 'px-6 py-5'}`}>
        {collapsed ? (
          <AppMark size={28} title="Keepr" />
        ) : (
          <div className="flex items-center gap-2">
            <Wordmark className="text-xl font-bold" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Admin</span>
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
        {/* Main nav items */}
        {mainNavItems.map((item) => renderNavItem(item))}

        {/* Collapsible Support section */}
        {canSeeSupport && (
          <div>
            <button
              onClick={() => {
                if (collapsed) {
                  onToggle();
                  setSupportExpanded(true);
                } else {
                  setSupportExpanded(!supportExpanded);
                }
              }}
              className={`flex items-center w-full rounded-md text-sm font-medium transition-colors ${
                collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
              } ${
                isSupportActive
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
              title={collapsed ? 'Support' : undefined}
            >
              <Headphones className="h-5 w-5 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Support</span>
                  {supportExpanded
                    ? <ChevronDown className="h-4 w-4 shrink-0" />
                    : <ChevronRight className="h-4 w-4 shrink-0" />
                  }
                </>
              )}
            </button>

            {supportExpanded && !collapsed && (
              <div className="mt-1 space-y-1">
                {supportSubItems.map((item) => renderNavItem(item, true))}
              </div>
            )}
          </div>
        )}

        {/* Collapsible Projects section */}
        {canSeePm && (
          <div>
            <button
              onClick={() => {
                if (collapsed) {
                  onToggle();
                  setPmExpanded(true);
                } else {
                  setPmExpanded(!pmExpanded);
                }
              }}
              className={`flex items-center w-full rounded-md text-sm font-medium transition-colors ${
                collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
              } ${
                isPmActive
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
              title={collapsed ? 'Projects' : undefined}
            >
              <KanbanSquare className="h-5 w-5 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Projects</span>
                  {pmExpanded
                    ? <ChevronDown className="h-4 w-4 shrink-0" />
                    : <ChevronRight className="h-4 w-4 shrink-0" />
                  }
                </>
              )}
            </button>

            {pmExpanded && !collapsed && (
              <div className="mt-1 space-y-1">
                {pmSubItems.map((item) => renderNavItem(item, true))}
              </div>
            )}
          </div>
        )}

        {/* Collapsible Settings section */}
        {canSeeSettings && (
          <div>
            <button
              onClick={() => {
                if (collapsed) {
                  // When collapsed, expand the sidebar instead of toggling sub-items
                  onToggle();
                  setSettingsExpanded(true);
                } else {
                  setSettingsExpanded(!settingsExpanded);
                }
              }}
              className={`flex items-center w-full rounded-md text-sm font-medium transition-colors ${
                collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
              } ${
                isSettingsActive
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
              title={collapsed ? 'Settings' : undefined}
            >
              <Settings className="h-5 w-5 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">Settings</span>
                  {settingsExpanded
                    ? <ChevronDown className="h-4 w-4 shrink-0" />
                    : <ChevronRight className="h-4 w-4 shrink-0" />
                  }
                </>
              )}
            </button>

            {/* Sub-items (only visible when expanded and sidebar not collapsed) */}
            {settingsExpanded && !collapsed && (
              <div className="mt-1 space-y-1">
                {settingsSubItems.map((item) => renderNavItem(item, true))}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* User info + Role badge + Sign Out */}
      <div className={`border-t border-gray-800 ${collapsed ? 'px-2 py-4' : 'px-3 py-4'}`}>
        {!collapsed && (
          <div className="px-3 py-1.5 mb-2">
            <div className="flex items-center gap-2.5">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt={displayName} className="h-8 w-8 rounded-full shrink-0" />
              ) : (
                <div className="h-8 w-8 rounded-full bg-primary-600 flex items-center justify-center text-white text-sm font-medium shrink-0">
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm text-gray-300 truncate leading-tight">{displayName}</p>
                {roleName && (
                  <p className="text-xs text-gray-500 truncate leading-tight">{roleName}</p>
                )}
              </div>
            </div>
          </div>
        )}
        <button
          onClick={signOut}
          className={`flex items-center w-full rounded-md text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white transition-colors ${
            collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
          }`}
          title={collapsed ? 'Sign Out' : undefined}
        >
          <LogOut className="h-5 w-5 shrink-0" />
          {!collapsed && <span>Sign Out</span>}
        </button>
      </div>
    </aside>
  );
}
