/**
 * BACKLOG-4238 — My Account: the AI apps link and the line under "Sign out all
 * devices" render only when the server says MCP is on; the account page passes
 * that flag from mcpEnabled(); "Sign out all devices" makes no MCP call.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@/lib/actions/myPhone', () => ({ getMyPhone: async () => ({ ok: true, phone: null }), setMyPhone: jest.fn() }));
jest.mock('@/components/providers/ImpersonationProvider', () => ({ useImpersonation: () => ({ isImpersonating: false }) }));
jest.mock('@/lib/actions/getActiveDevices', () => ({ getActiveDevices: async () => ({ success: true, devices: [] }) }));
jest.mock('@/lib/actions/signOutAllDevices', () => ({ signOutAllDevices: async () => ({ success: true }) }));

import AccountClient from '@/app/dashboard/account/AccountClient';
import { AI_APPS } from '@/lib/mcp/account/messages';

const ROOT = path.resolve(__dirname, '../../..');

describe('AccountClient', () => {
  it('MCP on: the AI apps link and the sign-out note are shown, both linking to the AI apps page', () => {
    render(<AccountClient account={null} mcpOn />);
    expect(screen.getByTestId('account-ai-apps-link')).toHaveAttribute('href', '/dashboard/account/ai-apps');
    const note = screen.getByTestId('sign-out-ai-apps-note');
    expect(note).toHaveTextContent(AI_APPS.signOutNote);
    expect(note.querySelector('a')).toHaveAttribute('href', '/dashboard/account/ai-apps');
  });

  it('MCP off: neither is shown', () => {
    render(<AccountClient account={null} mcpOn={false} />);
    expect(screen.queryByTestId('account-ai-apps-link')).toBeNull();
    expect(screen.queryByTestId('sign-out-ai-apps-note')).toBeNull();
    expect(screen.queryByText(AI_APPS.signOutNote)).toBeNull();
  });

  it('no flag: neither is shown', () => {
    render(<AccountClient account={null} />);
    expect(screen.queryByTestId('account-ai-apps-link')).toBeNull();
    expect(screen.queryByTestId('sign-out-ai-apps-note')).toBeNull();
  });
});

describe('source checks', () => {
  it('the account page passes mcpOn from mcpEnabled()', () => {
    const src = readFileSync(path.join(ROOT, 'app/dashboard/account/page.tsx'), 'utf8');
    expect(src).toContain('mcpOn={mcpEnabled()}');
  });

  it('signOutAllDevices.ts calls no MCP function', () => {
    const src = readFileSync(path.join(ROOT, 'lib/actions/signOutAllDevices.ts'), 'utf8');
    expect(src).toContain("signOut({ scope: 'global' })");
    for (const needle of ['mcp_', 'lib/mcp', 'disconnectAll', 'AiApp']) expect(src).not.toContain(needle);
  });
});
