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
 *
 * BACKLOG-3080 (My Transactions): a floor entry after Support, shown only when
 * the layout's `showMyTransactions` (lib/my-transactions-access.ts) says so.
 * The pages refuse on their own; a hidden entry is not the gate.
 *
 * BACKLOG-3844: Billing, immediately before My Account for every role, shown
 * only when the layout's `showBilling` (lib/billing/capabilities.ts
 * billingNavVisible) says so: the owner of a personal organization and
 * broker / admin / it_admin, flag on. Never a brokerage agent and never during
 * impersonation. The page refuses on its own; a hidden entry is not the gate.
 *
 * BACKLOG-3798: below md the aside is hidden and the same nav renders in a
 * slide-out drawer (mobileOpen), always expanded. The drawer is a SIBLING of
 * the aside, never inside it: the aside is display:none below md.
 *
 * BACKLOG-3896: the drawer is the @keepr/ui kit Drawer (Radix Dialog, portaled
 * to body). The kit owns focus trap, Escape, scroll lock, backdrop, focus
 * return, close-on-link-tap and close-at-md. Nav items, RBAC, checklists gating
 * and Sign Out stay here, passed in as children / footer.
 */

import type { RefObject } from 'react';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Contact,
  CreditCard,
  FileText,
  Files,
  Headphones,
  LayoutDashboard,
  LogOut,
  Settings,
  UserCircle,
  Users,
} from 'lucide-react';
import { AppMark, Drawer, Wordmark } from '@keepr/ui';
import { resolveViewerName } from '@/lib/utils/userDisplay';
import { mayUsePeople } from '@/lib/people-roles';

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

/** BACKLOG-3878: the one entry a suspended account keeps besides Billing and My Account. */
const supportNavItem: NavItem = { label: 'Support', href: '/dashboard/support', icon: Headphones };

/** BACKLOG-3080: the floor. No brokerage data, so no Submissions. */
const floorNavItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Support', href: '/dashboard/support', icon: Headphones },
];

const myTransactionsNavItem: NavItem = {
  label: 'My Transactions',
  href: '/dashboard/my-transactions',
  icon: FileText,
};

const checklistsNavItem: NavItem = { label: 'Checklists', href: '/dashboard/checklists', icon: ClipboardCheck };

/** A copy of `items` with `item` placed right after the entry with `href`. */
/** BACKLOG-3853 PR-2B: the note under a suspended brokerage's navigation (mockup v35). */
export function orgSuspendedNavNote(showBilling: boolean): string {
  return showBilling
    ? 'Only Billing, Support and My Account are available while your brokerage is suspended.'
    : 'Only Support and My Account are available while your brokerage is suspended.';
}

export function insertAfter(items: NavItem[], href: string, item: NavItem): NavItem[] {
  const i = items.findIndex((x) => x.href === href);
  return i < 0 ? [...items, item] : [...items.slice(0, i + 1), item, ...items.slice(i + 1)];
}

/**
 * BACKLOG-4007 PR-4 (founder e8571c1f): People, for admin, IT admin and broker
 * (lib/people-roles.ts). After the role's own entries, before Billing.
 */
const peopleNavItem: NavItem = { label: 'People', href: '/dashboard/people', icon: Contact };

/** BACKLOG-3844: right before My Account, when the layout says so. */
const billingNavItem: NavItem = { label: 'Billing', href: '/dashboard/billing', icon: CreditCard };

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
  /**
   * BACKLOG-3477: when set (and showChecklists is false), the Checklists entry
   * renders GRAYED, not as a link, with this one neutral line. Presentation
   * only; the route still refuses.
   */
  checklistsUnavailableLabel?: string | null;
  /** BACKLOG-3080: the layout passes lib/my-transactions-access.ts. Floor bucket only. */
  showMyTransactions?: boolean;
  /** BACKLOG-3080: not a full-portal user; show the floor bucket only. */
  floorOnly?: boolean;
  /**
   * BACKLOG-3844: the layout passes billingNavVisible(...), computed on the
   * server (the flag is server-only). The page refuses on its own.
   */
  showBilling?: boolean;
  /**
   * BACKLOG-3878: the account is suspended. Only Billing (when showBilling),
   * Support and My Account are listed. Presentation only: middleware and each
   * page refuse the rest.
   */
  suspended?: boolean;
  /**
   * BACKLOG-3853 PR-2B: the BROKERAGE is suspended and this is a full-portal
   * user (broker, admin, it_admin). Only Billing (when showBilling), Support and
   * My Account are listed, with a one-line note. Presentation only: middleware
   * and each page refuse the rest. The layout never sets it for an agent (their
   * floor stays, minus Checklists) or while impersonating.
   */
  orgSuspended?: boolean;
  /** BACKLOG-3798: the phone drawer is open (below md). Not rendered when false. */
  mobileOpen?: boolean;
  /** BACKLOG-3798: close the phone drawer (link tap, backdrop, Escape, close button). */
  onMobileClose?: () => void;
  /** BACKLOG-3896: focused when the phone drawer closes (the shell's menu button). */
  mobileReturnFocusRef?: RefObject<HTMLElement | null>;
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
  checklistsUnavailableLabel = null,
  showMyTransactions = false,
  floorOnly = false,
  showBilling = false,
  suspended = false,
  orgSuspended = false,
  mobileOpen = false,
  onMobileClose,
  mobileReturnFocusRef,
}: SidebarProps) {
  const pathname = usePathname();
  // BACKLOG-3080: the floor replaces the member and admin buckets entirely.
  const showFloorNav = floorOnly && !isImpersonating;

  // BACKLOG-907: preserve the exact nav gating of the previous top-nav.
  const showMemberNav = !showFloorNav && (isImpersonating || role !== 'it_admin');
  const showAdminNav =
    !showFloorNav && !isImpersonating && (role === 'admin' || role === 'it_admin');
  const showPeople = !showFloorNav && !isImpersonating && mayUsePeople(role);
  const showChecklistsEntry = showChecklists && !isImpersonating;
  const showChecklistsGrayed =
    !showChecklistsEntry && !!checklistsUnavailableLabel && !isImpersonating && !showFloorNav;
  const checklistsSlot = showChecklistsEntry || showChecklistsGrayed;
  const floorItems = showMyTransactions ? [...floorNavItems, myTransactionsNavItem] : floorNavItems;
  const adminItems = checklistsSlot
    ? insertAfter(adminNavItems, '/dashboard/users', checklistsNavItem)
    : adminNavItems;

  // BACKLOG-3077: shared resolution — the dashboard header names the same person.
  const name = resolveViewerName({ displayName, displayEmail }) || 'User';
  const initial = name.charAt(0).toUpperCase();

  /** '/dashboard' is a prefix of every route, so it matches exactly only. */
  const exactMatchPaths = new Set(['/dashboard']);

  const renderNavItem = (item: NavItem, isCollapsed: boolean, variant: 'rail' | 'drawer') => {
    // The drawer gets 44px rows. It closes itself on any link tap (kit Drawer),
    // so drawer links carry no onClick.
    const tall = variant === 'drawer' ? ' min-h-[44px]' : '';
    if (item === checklistsNavItem && showChecklistsGrayed) {
      const GrayedIcon = item.icon;
      return (
        <div
          key={item.href}
          aria-disabled="true"
          data-testid="checklists-nav-grayed"
          className={`flex cursor-not-allowed items-center rounded-md text-sm font-medium text-gray-500 ${
            isCollapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
          }${tall}`}
          title={isCollapsed ? `${item.label}: ${checklistsUnavailableLabel}` : checklistsUnavailableLabel ?? undefined}
        >
          <GrayedIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          {!isCollapsed && (
            <span className="flex min-w-0 flex-col leading-tight">
              <span>{item.label}</span>
              <span className="mt-0.5 text-xs font-normal text-gray-500">{checklistsUnavailableLabel}</span>
            </span>
          )}
        </div>
      );
    }
    const isActive = exactMatchPaths.has(item.href)
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(`${item.href}/`);
    const Icon = item.icon;

    return (
      <Link
        key={item.href}
        href={item.href}
        className={`flex items-center rounded-md text-sm font-medium transition-colors ${
          isCollapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2'
        }${tall} ${
          isActive
            ? 'bg-gray-800 text-white'
            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
        }`}
        title={isCollapsed ? item.label : undefined}
      >
        <Icon className="h-5 w-5 shrink-0" />
        {!isCollapsed && <span>{item.label}</span>}
      </Link>
    );
  };

  const renderNavItems = (isCollapsed: boolean, variant: 'rail' | 'drawer' = 'rail') => {
    const r = (item: NavItem) => renderNavItem(item, isCollapsed, variant);
    if (suspended && !isImpersonating) {
      return (
        <>
          {showBilling && r(billingNavItem)}
          {r(supportNavItem)}
          {personalNavItems.map(r)}
        </>
      );
    }
    if (orgSuspended && !isImpersonating) {
      return (
        <>
          {showBilling && r(billingNavItem)}
          {r(supportNavItem)}
          {personalNavItems.map(r)}
          {!isCollapsed && (
            <p data-testid="org-suspended-nav-note" className="px-3 pt-3 text-xs leading-snug text-gray-400">
              {orgSuspendedNavNote(showBilling)}
            </p>
          )}
        </>
      );
    }
    return (
      <>
        {showFloorNav && floorItems.map(r)}
        {showMemberNav && memberNavItems.map(r)}
        {!showAdminNav && checklistsSlot && r(checklistsNavItem)}
        {showAdminNav && adminItems.map(r)}
        {showPeople && r(peopleNavItem)}
        {showBilling && !isImpersonating && r(billingNavItem)}
        {personalNavItems.map(r)}
      </>
    );
  };

  return (
    <>
      <aside
        data-testid="desktop-sidebar"
        className={`sticky top-0 z-40 h-screen hidden md:flex flex-col bg-gray-900 text-white transition-all duration-200 ${
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
          {renderNavItems(collapsed)}
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

      {/* BACKLOG-3798 / BACKLOG-3896: phone drawer (kit Drawer, portaled to body,
          so never inside the aside, which is display:none below md). The kit
          wraps children in the nav and footer in the bordered block: pass the
          inner content only. */}
      <Drawer
        open={mobileOpen}
        onOpenChange={(open) => {
          if (!open) onMobileClose?.();
        }}
        returnFocusRef={mobileReturnFocusRef}
        header={
          <>
            <Wordmark className="text-xl font-bold" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Broker</span>
          </>
        }
        footer={
          <>
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
            <a
              href="/auth/logout"
              className="flex min-h-[44px] items-center gap-3 w-full rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white transition-colors"
            >
              <LogOut className="h-5 w-5 shrink-0" />
              <span>Sign Out</span>
            </a>
          </>
        }
      >
        {renderNavItems(false, 'drawer')}
      </Drawer>
    </>
  );
}
