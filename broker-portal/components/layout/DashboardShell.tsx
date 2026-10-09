'use client';

/**
 * DashboardShell - Broker Portal
 *
 * Client-side application chrome (dark collapsible sidebar + gray-50 content
 * well) following the shared Keepr design system shell recipe. The dashboard
 * layout stays a server component (it performs auth/role/impersonation
 * lookups) and delegates all interactive chrome to this component.
 */

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { Sidebar } from '@/components/layout/Sidebar';
import { MobileTopBar } from '@/components/layout/MobileTopBar';
import { SupportWidget } from '@/app/dashboard/components/SupportWidget';

export interface DashboardShellProps {
  children: React.ReactNode;
  role?: string;
  isImpersonating: boolean;
  displayName?: string;
  displayEmail: string;
  displayRole?: string;
  showChecklists?: boolean;
  /** BACKLOG-3477: set when the Checklists entry is grayed; the neutral line shown. */
  checklistsUnavailableLabel?: string | null;
  /** BACKLOG-3080: lib/my-transactions-access.ts, via the layout. */
  showMyTransactions?: boolean;
  /** BACKLOG-3080: not a full-portal user; the Sidebar shows the floor only. */
  floorOnly?: boolean;
}

export function DashboardShell({
  children,
  role,
  isImpersonating,
  displayName,
  displayEmail,
  displayRole,
  showChecklists,
  checklistsUnavailableLabel,
  showMyTransactions,
  floorOnly,
}: DashboardShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  // BACKLOG-3798: the phone drawer (below md). Separate from `collapsed`, which
  // only drives the desktop aside.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // A route change closes the drawer.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Start collapsed on small screens so content keeps usable width (the old
  // top-nav hid its links below sm; the sidebar equivalent is the icon rail).
  // Runs post-mount to avoid a server/client hydration mismatch.
  useEffect(() => {
    if (window.innerWidth < 768) setCollapsed(true);
  }, []);

  return (
    <div
      // Fixed-position elements in the content area (ReviewActions bar,
      // SupportWidget FAB) offset themselves past the sidebar with this var.
      // BACKLOG-3798: class-driven, 0 below md (no rail there; the drawer
      // overlays). Must not be an inline style: inline beats every class.
      className={`flex min-h-screen [--sidebar-w:0px] ${
        collapsed ? 'md:[--sidebar-w:4rem]' : 'md:[--sidebar-w:16rem]'
      }`}
    >
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        role={role}
        isImpersonating={isImpersonating}
        displayName={displayName}
        displayEmail={displayEmail}
        displayRole={displayRole}
        showChecklists={showChecklists}
        checklistsUnavailableLabel={checklistsUnavailableLabel}
        showMyTransactions={showMyTransactions}
        floorOnly={floorOnly}
        mobileOpen={menuOpen}
        onMobileClose={() => {
          setMenuOpen(false);
          menuButtonRef.current?.focus();
        }}
      />
      <div className="flex-1 flex flex-col min-w-0">
        <MobileTopBar ref={menuButtonRef} menuOpen={menuOpen} onOpenMenu={() => setMenuOpen(true)} />
        {/* Impersonation banner spans the content column so it never covers the sidebar */}
        <ImpersonationBanner />
        <main className="flex-1 p-4 md:p-6 bg-gray-50 overflow-auto">{children}</main>
      </div>

      {/* Floating Support Widget */}
      <SupportWidget />
    </div>
  );
}
