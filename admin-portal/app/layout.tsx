import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
// @keepr/ui theming contract: declares the shadcn semantic CSS variables
// (--primary, --border, --radius…) the library's components reference at
// runtime. Must be imported exactly once, at the app root. See
// packages/ui/src/styles/theme.css.
import '@keepr/ui/src/styles/theme.css';
import { AuthProvider } from '@/components/providers/AuthProvider';
import { PermissionsProvider } from '@/components/providers/PermissionsProvider';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Keepr - Admin Portal',
  description: 'Internal administration portal for Keepr',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          <PermissionsProvider>
            <main className="min-h-screen">{children}</main>
          </PermissionsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
