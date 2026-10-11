'use client';

/**
 * Sidebar Navigation - Admin Portal
 *
 * Left sidebar with navigation items.
 * Items are permission-gated based on the user's RBAC role.
 * Settings-related items are grouped under a collapsible section.
 *
 * BACKLOG-3841: below md the aside is hidden and the same nav renders in a
 * slide-out drawer (mobileOpen), always expanded. The drawer is a SIBLING of
 * the aside, never inside it, and goes through the same permission gate
 * (renderNavItem) and section checks (canSee*) as the aside.
 */

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { LayoutDashboard, BarChart3, Users, Building2, CreditCard, Headphones, Inbox, UserCheck, Settings, LogOut, ChevronLeft, FileText, ChevronDown, ChevronRight, Shield, KanbanSquare, ListChecks, FolderKanban, Calendar, Filter, FileBarChart2, X } from 'lucide-react';
import { AppMark, Wordmark } from '@keepr/ui';
import { useAuth } from '@/components/providers/AuthProvider';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import type { PermissionKey } from '@/lib/permissions';
import { PERMISSIONS } from '@/lib/permissions';
import { useFocusTrap } from '@/hooks/useFocusTrap';

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
  { label: 'Reports', href: '/dashboard/analytics/reports', icon: FileBarChart2, permission: PERMISSIONS.ANALYTICS_VIEW },
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
  /** BACKLOG-3841: phone drawer open (below md). */
  mobileOpen?: boolean;
  /** BACKLOG-3841: close the phone drawer (Escape, backdrop, close button, any link). */
  onMobileClose?: () => void;
}

const DESKTOP_QUERY = '(min-width: 768px)';

type GroupKind = 'support' | 'pm' | 'settings';

export function Sidebar({ collapsed, onToggle, mobileOpen = false, onMobileClose }: SidebarProps) {
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

  // BACKLOG-3841: drawer behaviour while open. useFocusTrap moves focus to the
  // first control (Close menu), keeps Tab inside and restores focus on close.
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onMobileClose);
  closeRef.current = onMobileClose;
  useFocusTrap(drawerRef, mobileOpen);
  useEffect(() => {
    if (!mobileOpen) return;
    const close = () => closeRef.current?.();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    let mql: MediaQueryList | null = null;
    const onMedia = (e: MediaQueryListEvent) => {
      if (e.matches) close();
    };
    if (typeof window.matchMedia === 'function') {
      mql = window.matchMedia(DESKTOP_QUERY);
      mql.addEventListener?.('change', onMedia);
    }

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      mql?.removeEventListener?.('change', onMedia);
    };
  }, [mobileOpen]);

  /** Paths that should use exact-match only (prefix of other routes) */
  const exactMatchPaths = new Set(['/dashboard', '/dashboard/analytics', '/dashboard/support', '/dashboard/pm']);

  /**
   * One nav link. `isCollapsed` is the aside's collapsed state, or false in the
   * drawer; `onNavigate` is set only in the drawer (closes it on tap).
   */
  const renderNavItem = (item: NavItem, isSubItem = false, isCollapsed = collapsed, onNavigate?: () => void) => {
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
        onClick={onNavigate}
        className={`flex items-center rounded-md text-sm font-medium transition-colors ${
          isCollapsed ? 'justify-center px-2 py-2' : isSubItem ? 'gap-3 pl-9 pr-3 py-2' : 'gap-3 px-3 py-2'
        } ${
          isActive
            ? 'bg-gray-800 text-white'
            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
        }${onNavigate ? ' min-h-[44px]' : ''}`}
        title={isCollapsed ? item.label : undefined}
      >
        <Icon className={`shrink-0 ${isSubItem ? 'h-4 w-4' : 'h-5 w-5'}`} />
        {!isCollapsed && <span>{item.label}</span>}
      </Link>
    );
  };

  const groups: Record<GroupKind, {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    visible: boolean;
    active: boolean;
    expanded: boolean;
    setExpanded: (v: boolean) => void;
    items: NavItem[];
  }> = {
    support: { label: 'Support', icon: Headphones, visible: canSeeSupport, active: isSupportActive, expanded: supportExpanded, setExpanded: setSupportExpanded, items: supportSubItems },
    pm: { label: 'Projects', icon: KanbanSquare, visible: canSeePm, active: isPmActive, expanded: pmExpanded, setExpanded: setPmExpanded, items: pmSubItems },
    settings: { label: 'Settings', icon: Settings, visible: canSeeSettings, active: isSettingsActive, expanded: settingsExpanded, setExpanded: setSettingsExpanded, items: settingsSubItems },
  };

  /**
   * One collapsible group (Support / Projects / Settings). In the collapsed
   * aside the header button expands the sidebar; otherwise (expanded aside,
   * and always in the drawer) it toggles its own sub-items.
   */
  const renderGroup = (kind: GroupKind, isCollapsed: boolean, onNavigate?: () => void) => {
    const g = groups[kind];
    if (!g.visible) return null;
    const Icon = g.icon;
    return (
      <div>
        <button
          onClick={() => {
            if (isCollapsed) {
              // When collapsed, expand the sidebar instead of toggling sub-items
              onToggle();
              g.setExpanded(true);
            } else {
              g.setExpanded(!g.expanded);
            }
          }}
          className={`flex items-center w-full rounded-md text-sm font-medium transition-colors ${
            isCollapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
          } ${
            g.active
              ? 'bg-gray-800 text-white'
              : 'text-gray-300 hover:bg-gray-800 hover:text-white'
          }${onNavigate ? ' min-h-[44px]' : ''}`}
          title={isCollapsed ? g.label : undefined}
        >
          <Icon className="h-5 w-5 shrink-0" />
          {!isCollapsed && (
            <>
              <span className="flex-1 text-left">{g.label}</span>
              {g.expanded
                ? <ChevronDown className="h-4 w-4 shrink-0" />
                : <ChevronRight className="h-4 w-4 shrink-0" />
              }
            </>
          )}
        </button>

        {/* Sub-items (only visible when expanded and sidebar not collapsed) */}
        {g.expanded && !isCollapsed && (
          <div className="mt-1 space-y-1">
            {g.items.map((item) => renderNavItem(item, true, isCollapsed, onNavigate))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
    <aside
      data-testid="desktop-sidebar"
      className={`sticky top-0 h-screen hidden md:flex flex-col bg-gray-900 text-white transition-all duration-200 ${collapsed ? 'w-16' : 'w-64'}`}
    >
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

        {/* Collapsible Support / Projects / Settings sections */}
        {renderGroup('support', collapsed)}
        {renderGroup('pm', collapsed)}
        {renderGroup('settings', collapsed)}
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

      {/* BACKLOG-3841: phone drawer. Rendered only while open, and outside the
          aside (which is display:none below md). Always expanded. */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-[60]" data-testid="mobile-nav-overlay">
          <div className="absolute inset-0 bg-gray-900/55" aria-hidden="true" onClick={onMobileClose} />
          <aside
            id="mobile-nav"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Main menu"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-gray-900 text-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-gray-800 py-2 pl-6 pr-2">
              <div className="flex items-center gap-2">
                <Wordmark className="text-xl font-bold" />
                <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Admin</span>
              </div>
              <button
                type="button"
                onClick={onMobileClose}
                aria-label="Close menu"
                className="flex h-11 w-11 items-center justify-center rounded-md text-gray-400 [@media(hover:hover)]:hover:bg-gray-800 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-600"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
              {mainNavItems.map((item) => renderNavItem(item, false, false, onMobileClose))}
              {renderGroup('support', false, onMobileClose)}
              {renderGroup('pm', false, onMobileClose)}
              {renderGroup('settings', false, onMobileClose)}
            </nav>
            <div className="border-t border-gray-800 px-3 py-4">
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
              <button
                onClick={signOut}
                className="flex min-h-[44px] items-center gap-3 w-full rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
              >
                <LogOut className="h-5 w-5 shrink-0" />
                <span>Sign Out</span>
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
