/**
 * Settings Screen (Android Companion)
 * Configuration-only screen: sync preferences, permissions, about.
 * Status/sync stats are on the home screen, not here.
 *
 * BACKLOG-1464: Full redesign for Keepr Companion UX.
 */

import { useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Switch,
  TouchableOpacity,
  Linking,
  Platform,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Sentry from '@sentry/react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  checkSmsPermissions,
  checkContactsPermissions,
  requestSmsPermissions,
  requestContactsPermissions,
} from '../../services/permissions';
import type {
  SmsPermissionResult,
  ContactsPermissionResult,
} from '../../services/permissions';
import {
  isBackgroundSyncActive,
  startBackgroundSync,
  stopBackgroundSync,
  updateSyncInterval,
} from '../../services/backgroundSync';
import {
  getSyncInterval,
  setSyncInterval,
  getBackgroundSyncEnabled,
  setBackgroundSyncEnabled,
  resetAllSyncData,
} from '../../services/smsQueueService';
import type { SyncIntervalValue } from '../../services/smsQueueService';
import { getVersionLabel } from '../../services/appVersion';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import {
  Button,
  Card,
  CardDivider,
  NavBarFooter,
  SupportButton,
} from '../../components/ui';

// ============================================
// CONSTANTS
// ============================================

/** Sync interval options for the picker */
const INTERVAL_OPTIONS: { label: string; value: SyncIntervalValue }[] = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: 'Manual only', value: 'manual' },
];

const PAIRING_STORAGE_KEY = '@keepr/pairing';
const PRIVACY_POLICY_URL = 'https://keeprcompliance.com/privacy';
const TERMS_URL = 'https://keeprcompliance.com/terms';

// ============================================
// COMPONENT
// ============================================

export default function SettingsScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Sync settings
  const [bgSyncEnabled, setBgSyncEnabled] = useState(true);
  const [syncInterval, setSyncIntervalState] =
    useState<SyncIntervalValue>(15);

  // Permissions
  const [smsPerms, setSmsPerms] = useState<SmsPermissionResult | null>(null);
  const [contactsPerms, setContactsPerms] =
    useState<ContactsPermissionResult | null>(null);

  // Diagnostics
  const [sendingReport, setSendingReport] = useState(false);
  // BACKLOG-2251: synchronous re-entrancy guard. React state updates are async,
  // so `sendingReport` alone can't block a rapid second tap that fires before
  // the re-render — the ref flips immediately.
  const sendingReportRef = useRef(false);

  // App info. BACKLOG-2956: read from the NATIVE package manifest and show the
  // build number alongside the version name ("1.1.0 (2)"). The version name
  // alone cannot identify a build — every companion build ever shipped called
  // itself 1.0.0 — so a support conversation needs the number in parentheses.
  const appVersion = getVersionLabel();

  // -------------------------------------------------------
  // Data loading
  // -------------------------------------------------------

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const [perms, cPerms, enabled, interval] = await Promise.all([
        checkSmsPermissions(),
        checkContactsPermissions(),
        getBackgroundSyncEnabled(),
        getSyncInterval(),
      ]);
      setSmsPerms(perms);
      setContactsPerms(cPerms);
      setBgSyncEnabled(enabled);
      setSyncIntervalState(interval);
    } catch (error) {
      console.error('[Settings] Failed to load settings:', error);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadSettings();
    }, [loadSettings]),
  );

  // -------------------------------------------------------
  // Sync handlers
  // -------------------------------------------------------

  const handleToggleBackgroundSync = useCallback(
    async (enabled: boolean): Promise<void> => {
      setBgSyncEnabled(enabled);
      await setBackgroundSyncEnabled(enabled);

      if (enabled) {
        // Re-read interval and start sync with current setting.
        const interval = await getSyncInterval();
        if (interval === 'manual') {
          // BACKLOG-2216: defense-in-depth. The UI now disables the toggle when
          // the interval is manual, so this branch shouldn't be reachable — but
          // if it ever is, do NOT register a task (backgrounding is impossible
          // in manual mode) rather than pretend it started.
          return;
        }
        await startBackgroundSync();
      } else {
        await stopBackgroundSync();
      }
    },
    [],
  );

  const handleIntervalChange = useCallback(
    async (interval: SyncIntervalValue): Promise<void> => {
      setSyncIntervalState(interval);
      await setSyncInterval(interval);

      // Only update the background task if sync is enabled
      const enabled = await getBackgroundSyncEnabled();
      if (enabled) {
        await updateSyncInterval(interval);
      }
    },
    [],
  );

  // -------------------------------------------------------
  // Permission handlers
  // -------------------------------------------------------

  const handleRequestSms = useCallback(async (): Promise<void> => {
    const result = await requestSmsPermissions();
    setSmsPerms(result);

    if (
      result.readSms === 'never_ask_again' ||
      result.receiveSms === 'never_ask_again'
    ) {
      openPermissionsDeniedAlert();
    }
  }, []);

  const handleRequestContacts = useCallback(async (): Promise<void> => {
    const result = await requestContactsPermissions();
    setContactsPerms(result);

    if (result.readContacts === 'never_ask_again') {
      openPermissionsDeniedAlert();
    }
  }, []);

  // -------------------------------------------------------
  // Device handlers
  // -------------------------------------------------------

  const handleUnpair = useCallback((): void => {
    Alert.alert(
      'Unpair Device',
      'This will disconnect from the desktop app and clear all sync data. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unpair',
          style: 'destructive',
          onPress: async () => {
            try {
              await stopBackgroundSync();
              await resetAllSyncData();
            } catch (error) {
              console.error('[Settings] Failed to stop background sync:', error);
            }
            await AsyncStorage.removeItem(PAIRING_STORAGE_KEY);
            router.replace('/(main)/home');
          },
        },
      ],
    );
  }, [router]);

  // -------------------------------------------------------
  // Diagnostics handlers
  // -------------------------------------------------------

  /**
   * Fires a real on-device Sentry event so telemetry delivery can be verified
   * server-side (BACKLOG-2197). Note: `_layout.tsx` sets `enabled: !__DEV__`, so
   * in a dev build this no-ops server-side by design — that is expected.
   */
  const handleSendTestReport = useCallback(async (): Promise<void> => {
    // BACKLOG-2251: guard synchronously against a double-fire. The ref is set
    // BEFORE the first await so a second tap in the same tick is rejected
    // (two events ~1s apart were observed in UAT). setState still drives the
    // spinner/disabled UI.
    if (sendingReportRef.current) return;
    sendingReportRef.current = true;
    setSendingReport(true);
    try {
      Sentry.captureException(
        new Error('BACKLOG-2197 on-device verification test event'),
        {
          tags: { component: 'diagnostics', trigger: 'manual-test-button' },
        },
      );
      // Force delivery so the event is flushed before the confirmation shows.
      // Note: @sentry/react-native's flush() takes no timeout arg (unlike the
      // browser/node SDKs); it uses the SDK's configured flushTimeout.
      await Sentry.flush();
      Alert.alert(
        'Test report sent',
        'It can take a minute to appear on the diagnostics dashboard.',
      );
    } catch (error) {
      console.error('[Settings] Failed to send test report:', error);
    } finally {
      // Re-enable only after the Alert flow completes.
      sendingReportRef.current = false;
      setSendingReport(false);
    }
  }, []);

  // -------------------------------------------------------
  // Render
  // -------------------------------------------------------

  // BACKLOG-2216: background sync cannot run while the interval is "Manual
  // only", so the toggle is shown disabled + OFF in that case (never a lying ON).
  const bgSyncUnavailable = syncInterval === 'manual';

  return (
    <View style={styles.screen}>
      <LinearGradient
        colors={[colors.account.headerStart, colors.account.headerEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.headerBar}
      >
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={styles.backChevron}>{'\u2039'}</Text>
          <Text style={styles.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
      </LinearGradient>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          // BACKLOG-2255 UAT: clear the Android nav bar at the bottom.
          { paddingBottom: spacing[12] + insets.bottom },
        ]}
        style={styles.scrollView}
      >
        {/* ========== SYNC ========== */}
        <Card title="Sync">
          {/* Background Sync toggle.
              BACKLOG-2216: background sync is impossible while the interval is
              "Manual only" (no periodic task can be registered). Rather than let
              the toggle flip ON and silently do nothing (the toggle used to
              lie), we DISABLE it and force it OFF whenever the interval is
              manual, with a hint explaining how to enable it. The toggle can
              never render ON while backgrounding is impossible. */}
          <View style={styles.row}>
            <Text
              style={[styles.rowLabel, bgSyncUnavailable && styles.rowLabelMuted]}
            >
              Background Sync
            </Text>
            <Switch
              testID="bg-sync-toggle"
              value={bgSyncUnavailable ? false : bgSyncEnabled}
              disabled={bgSyncUnavailable}
              onValueChange={handleToggleBackgroundSync}
              trackColor={{
                false: colors.gray[300],
                true: colors.primary[400],
              }}
              thumbColor={
                !bgSyncUnavailable && bgSyncEnabled
                  ? colors.primary[600]
                  : colors.gray[100]
              }
            />
          </View>
          {bgSyncUnavailable && (
            <Text style={styles.toggleHint}>
              Set a sync interval to enable background sync.
            </Text>
          )}
          <CardDivider />

          {/* Sync Interval selector */}
          <View style={styles.intervalSection}>
            <Text style={styles.rowLabel}>Sync Interval</Text>
            <View style={styles.intervalPicker}>
              {INTERVAL_OPTIONS.map((option) => {
                const selected = syncInterval === option.value;
                return (
                  <TouchableOpacity
                    key={String(option.value)}
                    style={[
                      styles.intervalOption,
                      selected && styles.intervalOptionSelected,
                    ]}
                    onPress={() => handleIntervalChange(option.value)}
                    activeOpacity={0.7}
                  >
                    <Text
                      style={[
                        styles.intervalOptionText,
                        selected && styles.intervalOptionTextSelected,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {syncInterval === 'manual' && (
              <Text style={styles.intervalHint}>
                Use "Sync Now" on the home screen to sync manually.
              </Text>
            )}
          </View>
        </Card>

        {/* ========== PERMISSIONS ========== */}
        <Card title="Permissions">
          <PermissionRow
            label="SMS Access"
            granted={smsPerms?.readSms === 'granted'}
            onGrant={handleRequestSms}
          />
          <CardDivider />
          <PermissionRow
            label="Contacts Access"
            granted={contactsPerms?.readContacts === 'granted'}
            onGrant={handleRequestContacts}
          />
          <CardDivider />
          <PermissionRow
            label="Receive SMS"
            granted={smsPerms?.receiveSms === 'granted'}
            onGrant={handleRequestSms}
          />
        </Card>

        {/* ========== DEVICE ========== */}
        <Card title="Device">
          <View style={styles.unpairSection}>
            <Text style={styles.unpairDescription}>
              Unpair this device from the Keepr desktop app. All sync data will
              be cleared.
            </Text>
            <Button
              title="Unpair Device"
              variant="danger"
              onPress={handleUnpair}
              fullWidth
            />
          </View>
        </Card>

        {/* ========== DIAGNOSTICS ========== */}
        <Card title="Diagnostics">
          <View style={styles.diagnosticsSection}>
            <Text style={styles.diagnosticsDescription}>
              Sends a test error to Keepr diagnostics so support can confirm this
              device can report issues.
            </Text>
            <Button
              title="Send Test Report"
              variant="outline"
              onPress={handleSendTestReport}
              loading={sendingReport}
              disabled={sendingReport}
              fullWidth
            />
          </View>
        </Card>

        {/* ========== ABOUT ========== */}
        <Card title="About">
          <View style={styles.row}>
            <Text style={styles.rowLabel}>App Version</Text>
            <Text testID="app-version-value" style={styles.rowValue}>
              {appVersion}
            </Text>
          </View>
          <CardDivider />
          <TouchableOpacity
            style={styles.row}
            onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}
            activeOpacity={0.7}
          >
            <Text style={styles.rowLabel}>Privacy Policy</Text>
            <Text style={styles.linkText}>{'\u2192'}</Text>
          </TouchableOpacity>
          <CardDivider />
          <TouchableOpacity
            style={styles.row}
            onPress={() => Linking.openURL(TERMS_URL)}
            activeOpacity={0.7}
          >
            <Text style={styles.rowLabel}>Terms of Service</Text>
            <Text style={styles.linkText}>{'\u2192'}</Text>
          </TouchableOpacity>
        </Card>
      </ScrollView>
      <NavBarFooter />
      <SupportButton />
    </View>
  );
}

// ============================================
// SUB-COMPONENTS
// ============================================

/** Single permission row with status indicator and grant button. */
function PermissionRow({
  label,
  granted,
  onGrant,
}: {
  label: string;
  granted: boolean;
  onGrant: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {granted ? (
        <View style={styles.permissionStatus}>
          <Text style={styles.permissionGranted}>{'\u2713'} On</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.grantButton}
          onPress={onGrant}
          activeOpacity={0.7}
        >
          <Text style={styles.grantButtonText}>Grant</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ============================================
// HELPERS
// ============================================

function openPermissionsDeniedAlert(): void {
  Alert.alert(
    'Permission Required',
    'This permission was permanently denied. Please enable it in Settings > Apps > Keepr Companion > Permissions.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Open Settings',
        onPress: () => {
          if (Platform.OS === 'android') {
            Linking.openSettings();
          }
        },
      },
    ],
  );
}

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.gray[50],
  },
  // Gradient header bar — matches the Account screen (desktop-parity wave).
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[10],
    paddingBottom: spacing[4],
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 80,
  },
  backChevron: {
    color: colors.white,
    fontSize: 22,
    marginRight: spacing[1],
    lineHeight: 22,
  },
  backLabel: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '500',
  },
  headerTitle: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '700',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing[4],
    paddingBottom: spacing[12],
  },

  // Row layout (used for toggle rows, info rows, link rows)
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing[3],
  },
  rowLabel: {
    ...textStyles.label,
    color: colors.gray[600],
    flexShrink: 0,
    marginRight: spacing[3],
  },
  // BACKLOG-2216: muted label when the Background Sync toggle is unavailable
  // (interval set to manual).
  rowLabelMuted: {
    color: colors.gray[400],
  },
  rowValue: {
    ...textStyles.label,
    color: colors.gray[900],
  },

  // BACKLOG-2216: hint under the Background Sync toggle explaining why it is
  // disabled when the interval is manual.
  toggleHint: {
    ...textStyles.caption,
    color: colors.gray[400],
    marginTop: spacing[1],
    marginBottom: spacing[1],
  },

  // Sync interval picker
  intervalSection: {
    paddingTop: spacing[3],
  },
  intervalPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    marginTop: spacing[2],
  },
  intervalOption: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.gray[300],
    backgroundColor: colors.white,
  },
  intervalOptionSelected: {
    borderColor: colors.primary[600],
    backgroundColor: colors.primary[50],
  },
  intervalOptionText: {
    ...textStyles.label,
    color: colors.gray[700],
  },
  intervalOptionTextSelected: {
    color: colors.primary[700],
  },
  intervalHint: {
    ...textStyles.caption,
    color: colors.gray[400],
    marginTop: spacing[2],
  },

  // Permissions
  permissionStatus: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  permissionGranted: {
    ...textStyles.label,
    color: colors.success[600],
  },
  grantButton: {
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: borderRadius.md,
    backgroundColor: colors.primary[50],
    borderWidth: 1,
    borderColor: colors.primary[200],
  },
  grantButtonText: {
    ...textStyles.label,
    color: colors.primary[700],
  },

  // Unpair
  unpairSection: {
    paddingVertical: spacing[2],
  },
  unpairDescription: {
    ...textStyles.caption,
    color: colors.gray[400],
    marginBottom: spacing[3],
  },

  // Diagnostics
  diagnosticsSection: {
    paddingVertical: spacing[2],
  },
  diagnosticsDescription: {
    ...textStyles.caption,
    color: colors.gray[400],
    marginBottom: spacing[3],
  },

  // Links
  linkText: {
    ...textStyles.label,
    color: colors.primary[600],
  },
});
