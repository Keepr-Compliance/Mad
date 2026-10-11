import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
// @keepr/ui theming contract: declares the shadcn semantic CSS variables
// (--primary, --border, --radius…) the library's components reference at
// runtime. Must be imported exactly once, at the app root. See
// packages/ui/src/styles/theme.css.
import '@keepr/ui/src/styles/theme.css';
import { AuthProvider } from '@/components/providers/AuthProvider';
import { PermissionsProvider } from '@/components/providers/PermissionsProvider';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { OfflineBanner } from '@/components/pwa/OfflineBanner';
import { NavigationProgress } from '@/components/pwa/NavigationProgress';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Keepr - Admin Portal',
  description: 'Internal administration portal for Keepr',
  appleWebApp: { capable: true, title: 'Keepr Admin', statusBarStyle: 'black' },
};

// Next 15: themeColor belongs in the viewport export, not metadata (BACKLOG-3797).
export const viewport: Viewport = { themeColor: '#111827' };

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ServiceWorkerRegister />
        <NavigationProgress />
        <OfflineBanner />
        <AuthProvider>
          <PermissionsProvider>
            <div className="min-h-screen">{children}</div>
          </PermissionsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
