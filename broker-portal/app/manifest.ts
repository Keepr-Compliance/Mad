import type { MetadataRoute } from 'next';

/**
 * Web app manifest — BACKLOG-3796. Served by Next at /manifest.webmanifest and
 * linked from every page automatically.
 *
 * theme_color matches the phone top bar (MobileTopBar, bg-gray-900).
 * background_color matches the page background (globals.css, 249 250 251).
 * Icons are generated from android-companion/assets/icon.png with `sips`; the
 * mark sits well inside the 40% maskable safe zone on a full-bleed background,
 * so the 512 file also serves as the maskable icon.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Keepr',
    short_name: 'Keepr',
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
