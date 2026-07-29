/**
 * Behavioral guard for BACKLOG-2216 — honest Background Sync toggle.
 *
 * The bug it accompanies: in `settings.tsx`, toggling Background Sync ON while
 * the sync interval was "Manual only" flipped the switch visually ON but
 * returned early WITHOUT registering any background task (backgrounding is
 * impossible in manual mode). The toggle lied: it showed ON while nothing ran.
 *
 * The fix makes the toggle honest — when the interval is manual it is DISABLED
 * and forced OFF, with a hint explaining how to enable it, so it can never
 * render ON as a no-op. With a real interval the toggle behaves as before.
 *
 * WHAT THIS TEST verifies:
 *   1. interval = manual -> toggle disabled AND value=false, even though the
 *      stored "enabled" flag is true (the exact lying-ON state the bug produced);
 *      the explanatory hint is shown.
 *   2. interval = 15 min -> toggle enabled; toggling it ON actually starts
 *      background sync (works as before); no manual hint.
 */
import React from 'react';
import { render, fireEvent, waitFor, screen } from '@testing-library/react-native';

// --- expo-router: settings uses useRouter() and useFocusEffect() (the latter
// runs loadSettings on focus; we run it once on mount). ---
jest.mock('expo-router', () => {
  const ReactModule = require('react');
  return {
    useRouter: () => ({ back: jest.fn(), replace: jest.fn() }),
    useFocusEffect: (cb: () => void | (() => void)) => {
      ReactModule.useEffect(() => {
        const cleanup = cb();
        return typeof cleanup === 'function' ? cleanup : undefined;
        // Re-run if the callback identity changes (mirrors real focus effect).
      }, [cb]);
    },
  };
});

// --- Native / presentation deps that don't load (or add noise) under jest. ---
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return {
    LinearGradient: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(View, null, children),
  };
});
jest.mock('@sentry/react-native', () => ({
  captureException: jest.fn(),
  flush: jest.fn(async () => true),
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' }, manifest2: {} },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(async () => undefined),
  getItem: jest.fn(async () => null),
  removeItem: jest.fn(async () => undefined),
}));

// --- Permissions service: settings loads permission status on focus. ---
jest.mock('../../../services/permissions', () => ({
  checkSmsPermissions: jest.fn(async () => ({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  })),
  checkContactsPermissions: jest.fn(async () => ({
    readContacts: 'granted',
    granted: true,
  })),
  requestSmsPermissions: jest.fn(async () => ({
    readSms: 'granted',
    receiveSms: 'granted',
    allGranted: true,
  })),
  requestContactsPermissions: jest.fn(async () => ({
    readContacts: 'granted',
    granted: true,
  })),
}));

// --- backgroundSync service: assert whether a task is (re)registered. ---
const mockStartBackgroundSync = jest.fn(async () => undefined);
const mockStopBackgroundSync = jest.fn(async () => undefined);
const mockUpdateSyncInterval = jest.fn(async (_i: unknown) => undefined);
jest.mock('../../../services/backgroundSync', () => ({
  isBackgroundSyncActive: jest.fn(async () => false),
  startBackgroundSync: () => mockStartBackgroundSync(),
  stopBackgroundSync: () => mockStopBackgroundSync(),
  updateSyncInterval: (i: unknown) => mockUpdateSyncInterval(i),
}));

// --- smsQueueService: the interval + enabled state that drive the toggle. ---
const mockGetSyncInterval = jest.fn();
const mockGetBackgroundSyncEnabled = jest.fn();
const mockSetBackgroundSyncEnabled = jest.fn(async (_v: boolean) => undefined);
jest.mock('../../../services/smsQueueService', () => ({
  getSyncInterval: () => mockGetSyncInterval(),
  setSyncInterval: jest.fn(async () => undefined),
  getBackgroundSyncEnabled: () => mockGetBackgroundSyncEnabled(),
  setBackgroundSyncEnabled: (v: boolean) => mockSetBackgroundSyncEnabled(v),
  resetAllSyncData: jest.fn(async () => undefined),
}));

// --- components/ui barrel: the real barrel transitively pulls in Sentry +
// Supabase (native modules). Lightweight stand-ins keep the tree renderable. ---
jest.mock('../../../components/ui', () => {
  const ReactModule = require('react');
  const { Text, Pressable, View } = require('react-native');
  return {
    Button: ({ title, onPress }: { title: string; onPress?: () => void }) =>
      ReactModule.createElement(
        Pressable,
        { onPress, accessibilityRole: 'button' },
        ReactModule.createElement(Text, null, title),
      ),
    Card: ({ title, children }: { title?: string; children?: React.ReactNode }) =>
      ReactModule.createElement(
        View,
        null,
        title ? ReactModule.createElement(Text, null, title) : null,
        children,
      ),
    CardDivider: () => null,
    NavBarFooter: () => null,
    SupportButton: () => null,
  };
});

import SettingsScreen from '../settings';

const HINT = 'Set a sync interval to enable background sync.';

describe('SettingsScreen — honest Background Sync toggle (BACKLOG-2216)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the toggle disabled + OFF (never a lying ON) when the interval is manual', async () => {
    // The pre-fix lying state: stored "enabled" is TRUE while the interval is
    // manual, so a naive render would show ON while nothing can run.
    mockGetSyncInterval.mockResolvedValue('manual');
    mockGetBackgroundSyncEnabled.mockResolvedValue(true);

    render(<SettingsScreen />);

    const toggle = await screen.findByTestId('bg-sync-toggle');

    await waitFor(() => {
      expect(toggle.props.disabled).toBe(true);
    });
    // Honest: OFF despite the stored enabled=true — the toggle cannot lie.
    expect(toggle.props.value).toBe(false);
    // The hint explains how to enable it.
    expect(screen.getByText(HINT)).toBeTruthy();
    // Nothing was registered (backgrounding is impossible in manual mode).
    expect(mockStartBackgroundSync).not.toHaveBeenCalled();
  });

  it('lets the toggle work as before when a real interval is set', async () => {
    mockGetSyncInterval.mockResolvedValue(15);
    mockGetBackgroundSyncEnabled.mockResolvedValue(false);

    render(<SettingsScreen />);

    const toggle = await screen.findByTestId('bg-sync-toggle');

    // Enabled + OFF initially; no manual hint.
    await waitFor(() => {
      expect(toggle.props.disabled).toBe(false);
    });
    expect(toggle.props.value).toBe(false);
    expect(screen.queryByText(HINT)).toBeNull();

    // Toggling ON with a real interval actually starts background sync.
    fireEvent(toggle, 'valueChange', true);

    await waitFor(() => {
      expect(mockStartBackgroundSync).toHaveBeenCalled();
    });
    expect(mockSetBackgroundSyncEnabled).toHaveBeenCalledWith(true);
  });
});
