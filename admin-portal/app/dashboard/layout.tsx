'use client';

/**
 * Dashboard Layout - Admin Portal
 *
 * Wraps all /dashboard/* routes with sidebar navigation and header.
 * BACKLOG-3841: below md the sidebar is replaced by MobileTopBar + a drawer.
 */

import { useState, useEffect, useRef, Suspense } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { MobileTopBar } from '@/components/layout/MobileTopBar';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // Close the phone drawer on route change.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div className="flex min-h-screen">
      <Suspense>
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
          mobileOpen={menuOpen}
          onMobileClose={() => {
            setMenuOpen(false);
            menuButtonRef.current?.focus();
          }}
        />
      </Suspense>
      <div className="flex-1 flex flex-col min-w-0">
        <MobileTopBar ref={menuButtonRef} menuOpen={menuOpen} onOpenMenu={() => setMenuOpen(true)} />
        <main className="flex-1 p-4 md:p-6 bg-gray-50 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
