'use client';

/**
 * DashboardShell - Broker Portal
 *
 * Client-side application chrome (dark collapsible sidebar + gray-50 content
 * well) following the shared Keepr design system shell recipe. The dashboard
 * layout stays a server component (it performs auth/role/impersonation
 * lookups) and delegates all interactive chrome to this component.
 */

import { useState } from 'react';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import { Sidebar } from '@/components/layout/Sidebar';
import { SupportWidget } from '@/app/dashboard/components/SupportWidget';

export interface DashboardShellProps {
  children: React.ReactNode;
  role?: string;
  isImpersonating: boolean;
  displayName?: string;
  displayEmail: string;
  displayRole?: string;
}

export function DashboardShell({
  children,
  role,
  isImpersonating,
  displayName,
  displayEmail,
  displayRole,
}: DashboardShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        role={role}
        isImpersonating={isImpersonating}
        displayName={displayName}
        displayEmail={displayEmail}
        displayRole={displayRole}
      />
      <div className="flex-1 flex flex-col min-w-0">
        {/* Impersonation banner spans the content column so it never covers the sidebar */}
        <ImpersonationBanner />
        <main className="flex-1 p-6 bg-gray-50 overflow-auto">{children}</main>
      </div>

      {/* Floating Support Widget */}
      <SupportWidget />
    </div>
  );
}
