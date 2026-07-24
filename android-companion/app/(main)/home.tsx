import { useEffect, useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  Linking,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import {
  startBackgroundSync,
  stopBackgroundSync,
  performSync,
  isBackgroundSyncActive,
} from '../../services/backgroundSync';
import type { SyncOperationResult } from '../../services/backgroundSync';
import { resetAllSyncData } from '../../services/smsQueueService';
import { getSyncStats, getQueueSize } from '../../services/smsQueueService';
import type { SyncStats } from '../../services/smsQueueService';
import {
  requestSmsPermissions,
  requestContactsPermissions,
} from '../../services/permissions';
import { registerDevice } from '../../services/syncService';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import {
  Header,
  HelpModal,
  StatusBadge,
  Card,
  CardDivider,
  CardRow,
  Button,
} from '../../components/ui';

/** Data encoded in the QR code from the desktop app */
interface PairingData {
  ip: string;
  port: number;
  secret: string;
  deviceName: string;
}

/** Stored pairing info in AsyncStorage */
interface StoredPairing {
  ip: string;
  port: number;
  secret: string;
  deviceName: string;
  pairedAt: string;
}

const PAIRING_STORAGE_KEY = '@keepr/pairing';

export default function HomeScreen(): React.JSX.Element {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState<StoredPairing | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStats, setSyncStats] = useState<SyncStats | null>(null);
  const [queueSize, setQueueSize] = useState(0);
  const [bgSyncActive, setBgSyncActive] = useState(false);
  const [lastSyncResult, setLastSyncResult] =
    useState<SyncOperationResult | null>(null);
  const [helpVisible, setHelpVisible] = useState(false);

  // TODO: Re-add screenshot capture when expo-screen-capture or a proper
  // native module setup is available. react-native-view-shot requires native
  // linking that may not work without a fresh prebuild (BACKLOG-1490).
  const openHelp = useCallback((): void => {
    setHelpVisible(true);
  }, []);

  // -------------------------------------------------------
  // Data loading
  // -------------------------------------------------------

  const loadAllData = useCallback(async (): Promise<void> => {
    try {
      const [stored, stats, queue, bgActive] = await Promise.all([
        AsyncStorage.getItem(PAIRING_STORAGE_KEY),
        getSyncStats(),
        getQueueSize(),
        isBackgroundSyncActive(),
      ]);
      setPairing(stored ? (JSON.parse(stored) as StoredPairing) : null);
      setSyncStats(stats);
      setQueueSize(queue);
      setBgSyncActive(bgActive);
    } catch (error) {
      console.error('[Home] Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  useFocusEffect(
    useCallback(() => {
      loadAllData();
    }, [loadAllData]),
  );

  // -------------------------------------------------------
  // Pairing
  // -------------------------------------------------------

  const savePairing = async (data: PairingData): Promise<void> => {
    const storedPairing: StoredPairing = {
      ...data,
      pairedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(
      PAIRING_STORAGE_KEY,
      JSON.stringify(storedPairing),
    );
    setPairing(storedPairing);

    // --- BACKLOG-1456: Auto-ping on pair + auto-first-sync ---
    // WARNING: This auto-ping/auto-sync logic must be preserved if this screen
    // is rewritten (BACKLOG-1463 pairing screen redesign).

    // Step 1: Immediately register with the desktop so it shows "Connected"
    try {
      const regResult = await registerDevice({
        ip: data.ip,
        port: data.port,
        secret: data.secret,
        deviceId: data.deviceName,
      });
      if (regResult.success) {
        console.log('[Pairing] Device registered with desktop');
      } else {
        console.warn('[Pairing] Device registration failed:', regResult.error);
      }
    } catch (error) {
      console.warn('[Pairing] Device registration error (non-fatal):', error);
    }

    // Step 2: Request SMS and contacts permissions, then start background sync
    try {
      await requestSmsPermissions();
      await requestContactsPermissions();
      await startBackgroundSync();
    } catch (error) {
      console.error('[Pairing] Failed to start background sync:', error);
    }

    // Step 3: Auto-trigger first sync immediately after pairing + permissions.
    try {
      const syncResult = await performSync();
      console.log(
        `[Pairing] Auto-first-sync complete: ${syncResult.sentMessages} msgs, ${syncResult.contactsSynced} contacts`,
      );
    } catch (error) {
      console.warn('[Pairing] Auto-first-sync error (non-fatal):', error);
    }
    // --- END BACKLOG-1456 ---
  };

  const handleBarCodeScanned = useCallback(
    async (result: { data: string }): Promise<void> => {
      if (!scanning) return;
      setScanning(false);

      try {
        const data = JSON.parse(result.data) as PairingData;

        if (!data.ip || !data.port || !data.secret || !data.deviceName) {
          Alert.alert(
            'Invalid QR Code',
            'This QR code does not contain valid pairing data. Please scan the QR code shown in the Keepr desktop application.',
          );
          return;
        }

        if (!/^[0-9a-f]{64}$/i.test(data.secret)) {
          Alert.alert(
            'Invalid QR Code',
            'The pairing code is not in the expected format.',
          );
          return;
        }

        await savePairing(data);
        Alert.alert(
          'Paired Successfully',
          `Connected to ${data.deviceName} at ${data.ip}:${data.port}`,
        );
      } catch {
        Alert.alert(
          'Invalid QR Code',
          'Could not read the QR code. Please try again with the QR code from the Keepr desktop application.',
        );
      }
    },
    [scanning],
  );

  const handleStartScanning = useCallback(async (): Promise<void> => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert(
          'Camera Permission Required',
          'Please grant camera access in Settings to scan QR codes.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }
    }
    setScanning(true);
  }, [permission, requestPermission]);

  // -------------------------------------------------------
  // Sync
  // -------------------------------------------------------

  const handleSyncNow = useCallback(async (): Promise<void> => {
    if (syncing) return;
    setSyncing(true);

    try {
      const result = await performSync();
      setLastSyncResult(result);

      const [stats, queue] = await Promise.all([
        getSyncStats(),
        getQueueSize(),
      ]);
      setSyncStats(stats);
      setQueueSize(queue);

      if (result.error) {
        const title =
          result.errorType === 'timeout'
            ? 'Connection Timed Out'
            : result.errorType === 'network_after_connect'
              ? 'Transfer Failed'
              : result.errorType === 'connection_refused'
                ? 'Desktop Not Running'
                : 'Sync Issue';
        Alert.alert(title, result.error);
      } else if (result.sentMessages > 0 || result.contactsSynced > 0) {
        const messagePart = `${result.sentMessages} message${result.sentMessages !== 1 ? 's' : ''}`;
        const contactPart = `${result.contactsSynced} contact${result.contactsSynced !== 1 ? 's' : ''}`;
        Alert.alert(
          'Sync Complete',
          `Sent ${messagePart} and ${contactPart} to desktop.`,
        );
      } else if (
        result.newMessages === 0 &&
        result.sentMessages === 0 &&
        result.contactsSynced === 0
      ) {
        Alert.alert('Up to Date', 'Nothing new to sync.');
      }
    } catch (error) {
      Alert.alert(
        'Sync Failed',
        error instanceof Error ? error.message : 'Unknown error',
      );
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

  // -------------------------------------------------------
  // Render: Loading
  // -------------------------------------------------------

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
      </View>
    );
  }

  // -------------------------------------------------------
  // Render: QR Scanner
  // -------------------------------------------------------

  if (scanning) {
    return (
      <View style={styles.scannerContainer}>
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarCodeScanned}
        />
        <View style={styles.scannerOverlay}>
          <View style={styles.scannerFrame} />
          <Text style={styles.scannerText}>
            Point camera at the QR code on your Keepr desktop app
          </Text>
        </View>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={() => setScanning(false)}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // -------------------------------------------------------
  // Render: Not Paired
  // -------------------------------------------------------

  if (!pairing) {
    return (
      <View style={styles.screen}>
        <Header
          title="Keepr Companion"
          rightActions={[
            {
              icon: '\u2753',
              onPress: () => void openHelp(),
              accessibilityLabel: 'Help',
            },
          ]}
        />
        <View style={styles.centered}>
          <StatusBadge status="disconnected" label="Not Paired" />
          <Text style={styles.heroTitle}>Pair with Keepr</Text>
          <Text style={styles.heroDescription}>
            Scan the QR code displayed in the Keepr desktop application to
            connect this device as an SMS companion.
          </Text>
          <Button
            title="Scan QR Code"
            onPress={handleStartScanning}
            size="lg"
          />
        </View>
        <HelpModal
          visible={helpVisible}
          onClose={() => setHelpVisible(false)}
        />
      </View>
    );
  }

  // -------------------------------------------------------
  // Render: Paired / Home
  // -------------------------------------------------------

  const pairedDate = new Date(pairing.pairedAt);

  return (
    <View style={styles.screen}>
      <Header
        title="Keepr Companion"
        leftActions={[
          {
            icon: '\uD83D\uDC64',
            onPress: () => router.push('/(main)/account'),
            accessibilityLabel: 'Account',
          },
        ]}
        rightActions={[
          {
            icon: '\u2699\uFE0F',
            onPress: () => router.push('/(main)/settings'),
            accessibilityLabel: 'Settings',
          },
          {
            icon: '\u2753',
            onPress: () => void openHelp(),
            accessibilityLabel: 'Help',
          },
        ]}
      />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        style={styles.scrollView}
      >
        {/* Status */}
        <View style={styles.statusSection}>
          <StatusBadge status="connected" label="Paired" />
        </View>

        {/* Device Info */}
        <Card title="Device">
          <CardRow label="Desktop" value={pairing.deviceName} />
          <CardDivider />
          <CardRow
            label="Address"
            value={`${pairing.ip}:${pairing.port}`}
            mono
          />
          <CardDivider />
          <CardRow
            label="Paired Since"
            value={pairedDate.toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          />
        </Card>

        {/* Sync Stats */}
        <Card title="Sync Status">
          <CardRow
            label="Messages Synced"
            value={String(syncStats?.totalSynced ?? 0)}
          />
          <CardDivider />
          <CardRow
            label="Last Sync"
            value={
              syncStats?.lastSyncTime
                ? formatRelativeTime(syncStats.lastSyncTime)
                : 'Never'
            }
          />
          <CardDivider />
          <CardRow label="Queue" value={String(queueSize)} />
          <CardDivider />
          <CardRow
            label="Background Sync"
            value={bgSyncActive ? 'Active' : 'Inactive'}
            valueColor={bgSyncActive ? colors.success[600] : colors.gray[400]}
          />
        </Card>

        {/* Last Sync Result */}
        {lastSyncResult && (
          <Card title="Last Manual Sync">
            <CardRow
              label="New Messages"
              value={String(lastSyncResult.newMessages)}
            />
            <CardDivider />
            <CardRow
              label="Sent to Desktop"
              value={String(lastSyncResult.sentMessages)}
            />
            <CardDivider />
            <CardRow
              label="Contacts Synced"
              value={String(lastSyncResult.contactsSynced ?? 0)}
            />
            <CardDivider />
            <CardRow
              label="Desktop Reachable"
              value={lastSyncResult.desktopReachable ? 'Yes' : 'No'}
              valueColor={
                lastSyncResult.desktopReachable
                  ? colors.success[600]
                  : colors.danger[500]
              }
            />
            {lastSyncResult.error && (
              <>
                <CardDivider />
                <CardRow label="Error" value={lastSyncResult.error} />
              </>
            )}
          </Card>
        )}

        {/* Sync Now button */}
        <View style={styles.buttonRow}>
          <View style={styles.buttonFlex}>
            <Button
              title="Sync Now"
              onPress={handleSyncNow}
              loading={syncing}
              disabled={syncing}
              fullWidth
            />
          </View>
          <View style={styles.buttonFlex}>
            <Button
              title="Refresh"
              variant="outline"
              onPress={loadAllData}
              fullWidth
            />
          </View>
        </View>
      </ScrollView>
      <HelpModal
        visible={helpVisible}
        onClose={() => setHelpVisible(false)}
        screenshotBase64={null}
      />
    </View>
  );
}

// ============================================
// HELPERS
// ============================================

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();

  if (diffMs < 60_000) return 'Just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} min ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} hr ago`;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ============================================
// STYLES
// ============================================

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.gray[50],
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
    backgroundColor: colors.gray[50],
  },
  heroTitle: {
    ...textStyles.heading,
    color: colors.gray[900],
    marginTop: spacing[6],
    marginBottom: spacing[3],
  },
  heroDescription: {
    ...textStyles.body,
    textAlign: 'center',
    color: colors.gray[600],
    marginBottom: spacing[8],
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing[4],
    paddingBottom: spacing[12],
  },
  statusSection: {
    alignItems: 'center',
    marginBottom: spacing[5],
    marginTop: spacing[2],
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing[3],
    marginTop: spacing[2],
  },
  buttonFlex: {
    flex: 1,
  },

  // Scanner styles (preserved from original)
  scannerContainer: {
    flex: 1,
    backgroundColor: colors.black,
  },
  camera: {
    flex: 1,
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scannerFrame: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: colors.white,
    borderRadius: borderRadius.xl,
  },
  scannerText: {
    color: colors.white,
    ...textStyles.label,
    textAlign: 'center',
    marginTop: spacing[6],
    paddingHorizontal: spacing[10],
  },
  cancelButton: {
    position: 'absolute',
    bottom: 60,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: spacing[8],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.full,
  },
  cancelButtonText: {
    color: colors.white,
    ...textStyles.button,
  },
});
