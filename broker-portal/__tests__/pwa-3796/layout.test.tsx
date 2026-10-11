/**
 * BACKLOG-3796 — the root layout is the reachability root of the PWA: it mounts
 * ServiceWorkerRegister on every route, and carries the iOS standalone metadata
 * and the theme colour.
 *
 * The layout is rendered for real (RootLayout is awaited) and the returned
 * element tree is walked; only its server-side collaborators are mocked.
 */

import React from 'react';

jest.mock('next/font/google', () => ({ Inter: () => ({ className: 'inter' }) }));
jest.mock('@keepr/ui/src/styles/theme.css', () => ({}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/components/providers/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/providers/ImpersonationProvider', () => ({
  ImpersonationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import RootLayout, { metadata, viewport } from '@/app/layout';
import { ServiceWorkerRegister } from '@/components/pwa/ServiceWorkerRegister';
import { AuthProvider } from '@/components/providers/AuthProvider';

type El = React.ReactElement<{ children?: React.ReactNode; className?: string }>;

function childrenOf(el: El): El[] {
  return React.Children.toArray(el.props.children).filter(React.isValidElement) as El[];
}

async function renderBody(): Promise<El> {
  const html = (await RootLayout({ children: <div data-testid="page" /> })) as El;
  expect(html.type).toBe('html');
  const body = childrenOf(html).find((c) => c.type === 'body');
  expect(body).toBeDefined();
  return body as El;
}

describe('BACKLOG-3796 root layout', () => {
  it('mounts ServiceWorkerRegister as the first child of <body>, before AuthProvider', async () => {
    const body = await renderBody();
    const kids = childrenOf(body);
    expect(kids.map((k) => k.type)).toEqual([ServiceWorkerRegister, AuthProvider]);
  });

  it('declares iOS standalone metadata with the short title "Keepr"', () => {
    expect(metadata.appleWebApp).toEqual({ capable: true, title: 'Keepr', statusBarStyle: 'black' });
    expect(metadata.title).toBe('Keepr - Broker Portal');
  });

  it('puts themeColor in the viewport export, not in metadata (Next 15)', () => {
    expect(viewport.themeColor).toBe('#111827');
    expect(metadata).not.toHaveProperty('themeColor');
  });
});
