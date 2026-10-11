import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
// @keepr/ui theming contract: declares the shadcn CSS variables (--primary,
// --border, --radius, …) the shared component library reads. Import ONCE at
// the app root. Values derive from @keepr/design-system tokens (see the
// package README), so this stays visually consistent with the existing tokens.
import '@keepr/ui/src/styles/theme.css';
import { AuthProvider } from '@/components/providers/AuthProvider';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { ImpersonationProvider } from '@/components/providers/ImpersonationProvider';
import { getImpersonationSession } from '@/lib/impersonation';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Keepr - Broker Portal',
  description: 'Review and approve real estate transaction audits',
  appleWebApp: { capable: true, title: 'Keepr', statusBarStyle: 'black' },
};

// Next 15: themeColor belongs in the viewport export, not metadata (BACKLOG-3796).
export const viewport: Viewport = { themeColor: '#111827' };

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const impersonationSession = await getImpersonationSession();

  // Strip server-side-only fields before passing to the client component.
  // admin_user_id and target_user_id must never appear in the RSC payload.
  const clientSession = impersonationSession
    ? (() => {
        const { admin_user_id: _a, target_user_id: _t, ...rest } = impersonationSession;
        return rest;
      })()
    : null;

  return (
    <html lang="en">
      <body className={inter.className}>
        <ServiceWorkerRegister />
        <AuthProvider>
          <ImpersonationProvider session={clientSession}>
            <main className="min-h-screen">{children}</main>
          </ImpersonationProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
