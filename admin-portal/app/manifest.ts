import type { MetadataRoute } from 'next';

/**
 * Web app manifest — BACKLOG-3797. Served by Next at /manifest.webmanifest and
 * linked from every page automatically. Same shape as the broker portal's
 * (BACKLOG-3796); only the name differs.
 *
 * theme_color matches the phone top bar (MobileTopBar, bg-gray-900).
 * background_color matches the page background (globals.css, 249 250 251).
 * Icons are the broker portal's files (same K mark): generated from
 * android-companion/assets/icon.png, mark inside the maskable safe zone, so the
 * 512 file also serves as the maskable icon.
 *
 * If a phone truncates "Keepr Admin" under the icon, change short_name AND
 * metadata.appleWebApp.title in app/layout.tsx to "Admin".
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Keepr Admin',
    short_name: 'Keepr Admin',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    theme_color: '#111827',
    background_color: '#f9fafb',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
