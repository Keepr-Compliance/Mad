/**
 * Settings Screen (Android Companion)
 * Configuration-only screen: sync preferences, permissions, about.
 * Status/sync stats are on the home screen, not here.
 *
 * BACKLOG-1464: Full redesign for Keepr Companion UX.
 */

import { useState, useCallback } from 'react';
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
import { useRouter, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';
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
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import { Header, Button, Card, CardDivider } from '../../components/ui';

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

  // Sync settings
  const [bgSyncEnabled, setBgSyncEnabled] = useState(true);
  const [syncInterval, setSyncIntervalState] =
    useState<SyncIntervalValue>(15);

  // Permissions
  const [smsPerms, setSmsPerms] = useState<SmsPermissionResult | null>(null);
  const [contactsPerms, setContactsPerms] =
    useState<ContactsPermissionResult | null>(null);

  // App info
  const appVersion =
    Constants.expoConfig?.version ??
    Constants.manifest2?.extra?.expoClient?.version ??
    '1.0.0';

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
        // Re-read interval and start sync with current setting
        const interval = await getSyncInterval();
        if (interval === 'manual') {
          // If interval was manual, just enable the toggle but don't register task
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
  // Render
  // -------------------------------------------------------

  return (
    <View style={styles.screen}>
      <Header
        title="Settings"
        leftActions={[
          {
            icon: '\u2190',
            onPress: () => router.back(),
            accessibilityLabel: 'Back',
          },
        ]}
      />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        style={styles.scrollView}
      >
        {/* ========== SYNC ========== */}
        <Card title="Sync">
          {/* Background Sync toggle */}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Background Sync</Text>
            <Switch
              value={bgSyncEnabled}
              onValueChange={handleToggleBackgroundSync}
              trackColor={{
                false: colors.gray[300],
                true: colors.primary[400],
              }}
              thumbColor={
                bgSyncEnabled ? colors.primary[600] : colors.gray[100]
              }
            />
          </View>
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

        {/* ========== ABOUT ========== */}
        <Card title="About">
          <View style={styles.row}>
            <Text style={styles.rowLabel}>App Version</Text>
            <Text style={styles.rowValue}>{appVersion}</Text>
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
  rowValue: {
    ...textStyles.label,
    color: colors.gray[900],
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

  // Links
  linkText: {
    ...textStyles.label,
    color: colors.primary[600],
  },
});
