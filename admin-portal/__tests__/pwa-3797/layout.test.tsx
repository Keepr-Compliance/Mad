/**
 * BACKLOG-3797 — the root layout is the reachability root of the admin PWA: it
 * mounts ServiceWorkerRegister on every route, and carries the iOS standalone
 * metadata and the theme colour.
 *
 * The layout is rendered for real and the returned element tree is walked;
 * only its collaborators are mocked.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/google', () => ({ Inter: () => ({ className: 'inter' }) }));
vi.mock('@keepr/ui/src/styles/theme.css', () => ({}));
vi.mock('@/app/globals.css', () => ({}));
vi.mock('@/components/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/providers/PermissionsProvider', () => ({
  PermissionsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import RootLayout, { metadata, viewport } from '@/app/layout';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { AuthProvider } from '@/components/providers/AuthProvider';
import { NavigationProgress } from '@/components/pwa/NavigationProgress';
import { OfflineBanner } from '@/components/pwa/OfflineBanner';

type El = React.ReactElement<{ children?: React.ReactNode; className?: string }>;

function childrenOf(el: El): El[] {
  return React.Children.toArray(el.props.children).filter(React.isValidElement) as El[];
}

async function renderBody(): Promise<El> {
  // Admin's RootLayout is synchronous; awaiting a non-promise is harmless and
  // keeps the test valid if it ever becomes async.
  const html = (await RootLayout({ children: <div data-testid="page" /> })) as El;
  expect(html.type).toBe('html');
  const body = childrenOf(html).find((c) => c.type === 'body');
  expect(body).toBeDefined();
  return body as El;
}

describe('BACKLOG-3797 admin root layout', () => {
  it('mounts ServiceWorkerRegister, NavigationProgress and OfflineBanner in <body>, before AuthProvider', async () => {
    const body = await renderBody();
    const kids = childrenOf(body);
    expect(kids.map((k) => k.type)).toEqual([ServiceWorkerRegister, NavigationProgress, OfflineBanner, AuthProvider]);
  });

  it('declares iOS standalone metadata with the home-screen title "Keepr Admin"', () => {
    expect(metadata.appleWebApp).toEqual({ capable: true, title: 'Keepr Admin', statusBarStyle: 'black' });
    expect(metadata.title).toBe('Keepr - Admin Portal');
  });

  it('puts themeColor in the viewport export, not in metadata (Next 15)', () => {
    expect(viewport.themeColor).toBe('#111827');
    expect(metadata).not.toHaveProperty('themeColor');
  });
});
