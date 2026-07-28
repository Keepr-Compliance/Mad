import { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  Linking,
  Platform,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import {
  getSyncStats,
  getQueueSize,
  getBackgroundSyncEnabled,
} from '../../services/smsQueueService';
import type { SyncStats } from '../../services/smsQueueService';
import { getSyncFreshness, formatRelativeTime } from '../../services/syncStaleness';
import {
  smsReadErrorMessage,
  smsPermissionBannerCopy,
} from '../../services/smsReader';
import {
  shouldPromptBatteryOptimization,
  openBatteryOptimizationSettings,
  getBatteryOptPromptDismissed,
  setBatteryOptPromptDismissed,
} from '../../services/batteryOptimization';
import {
  checkSmsPermissions,
  requestSmsPermissions,
  requestContactsPermissions,
} from '../../services/permissions';
import { registerDevice } from '../../services/syncService';
import { forceFullContactResync } from '../../services/contactSyncState';
import {
  checkDesktopAccountMatch,
  accountMatchMessage,
} from '../../services/accountMatch';
import { pairFailureMessage } from '../../services/pairingFeedback';
import { syncDisconnection } from '../../services/syncFailure';
import { getSession } from '../../services/authService';
import type { Session } from '@supabase/supabase-js';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import {
  Header,
  Avatar,
  SupportButton,
  NavBarFooter,
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
  /**
   * SHA-256 hash (hex) of the desktop's Supabase user id (BACKLOG-2224).
   * Present only on newer desktop builds; used for the account-match pre-check.
   */
  desktopUserIdHash?: string;
}

/** Stored pairing info in AsyncStorage */
interface StoredPairing {
  ip: string;
  port: number;
  secret: string;
  deviceName: string;
  pairedAt: string;
  /**
   * BACKLOG-2210: the desktop-minted device identity (UUID), adopted from the
   * /register response. Absent until the register round-trip completes; the sync
   * layer falls back to `deviceName` when it is missing (legacy pairing).
   */
  deviceId?: string;
}

const PAIRING_STORAGE_KEY = '@keepr/pairing';

/**
 * BACKLOG-2214: sticky flag recording that READ_SMS has been granted at least
 * once on this install. It lets the single not-granted banner tell apart the two
 * causes so its copy can adapt (never-granted vs revoked) while staying ONE
 * surface: absent → the user skipped the permission in onboarding and never
 * granted it; 'true' → they granted it before (so a later denied state is a
 * revocation). Set the instant a live check observes 'granted'.
 */
const SMS_GRANTED_ONCE_KEY = '@keepr/sms-granted-once';

export default function HomeScreen(): React.JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
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
  const [session, setSession] = useState<Session | null>(null);
  // BACKLOG-2209 + BACKLOG-2214: whether READ_SMS is currently NOT granted —
  // whether it was revoked in Android Settings after pairing (2209) OR skipped
  // during onboarding and never granted (2214). Live-checked on load + every
  // foreground so the one "SMS access needed" banner is proactive (no manual
  // "Sync Now" needed) and clears immediately on grant.
  const [smsNotGranted, setSmsNotGranted] = useState(false);
  // BACKLOG-2214: whether READ_SMS has been granted at least once (sticky flag +
  // the current live check). Distinguishes the never-granted from the revoked
  // cause so the SAME banner can adapt its copy without forking into two.
  const [smsEverGranted, setSmsEverGranted] = useState(false);
  // BACKLOG-2204: fire the one-time battery-optimization prompt at most once per
  // mount (a synchronous guard — useFocusEffect can re-run loadAllData rapidly).
  const batteryPromptShownRef = useRef(false);

  // Load the session once for the header avatar initial (name → email).
  useEffect(() => {
    let mounted = true;
    getSession()
      .then((s) => {
        if (mounted) setSession(s);
      })
      .catch(() => {
        /* avatar falls back to "?" */
      });
    return () => {
      mounted = false;
    };
  }, []);

  const avatarName =
    session?.user?.user_metadata?.full_name ??
    session?.user?.user_metadata?.name ??
    '';
  const avatarEmail = session?.user?.email ?? '';

  // Reusable header avatar → Account (BACKLOG-2254).
  const headerAvatar = (
    <TouchableOpacity
      onPress={() => router.push('/(main)/account')}
      activeOpacity={0.8}
      accessibilityRole="button"
      accessibilityLabel="Account"
    >
      <Avatar name={avatarName} email={avatarEmail} size={32} />
    </TouchableOpacity>
  );

  // -------------------------------------------------------
  // Data loading
  // -------------------------------------------------------

  /**
   * BACKLOG-2204: one-time, guarded prompt asking the user to exempt Keepr from
   * battery optimization. Only fires when it is genuinely appropriate (Android,
   * paired, background sync on, not dismissed, and sync is actually stale), and
   * at most once per mount. Either choice dismisses it so we never nag — the
   * persistent stale banner remains as the ongoing affordance.
   */
  const maybePromptBatteryOptimization = useCallback(
    async (stats: SyncStats | null, paired: boolean): Promise<void> => {
      if (batteryPromptShownRef.current) return;

      const lastSync = stats?.lastSuccessfulSyncAt ?? stats?.lastSyncTime ?? null;
      const freshness = getSyncFreshness(lastSync);

      const [backgroundSyncEnabled, dismissed] = await Promise.all([
        getBackgroundSyncEnabled(),
        getBatteryOptPromptDismissed(),
      ]);

      const shouldPrompt = shouldPromptBatteryOptimization({
        platformOS: Platform.OS,
        paired,
        backgroundSyncEnabled,
        dismissed,
        freshness,
      });
      if (!shouldPrompt) return;

      batteryPromptShownRef.current = true;
      Alert.alert(
        'Keep Keepr syncing in the background',
        "Android may be pausing Keepr Companion to save battery, so texts can stop syncing while your phone is idle. To keep sync reliable, allow Keepr Companion to run in the background (turn off battery optimization for it).",
        [
          {
            text: 'Not now',
            style: 'cancel',
            onPress: () => {
              void setBatteryOptPromptDismissed(true);
            },
          },
          {
            text: 'Open Settings',
            onPress: () => {
              void setBatteryOptPromptDismissed(true);
              void openBatteryOptimizationSettings();
            },
          },
        ],
      );
    },
    [],
  );

  const loadAllData = useCallback(async (): Promise<void> => {
    try {
      const [stored, stats, queue, bgActive, smsPerm, grantedOnce] =
        await Promise.all([
          AsyncStorage.getItem(PAIRING_STORAGE_KEY),
          getSyncStats(),
          getQueueSize(),
          isBackgroundSyncActive(),
          checkSmsPermissions(),
          AsyncStorage.getItem(SMS_GRANTED_ONCE_KEY),
        ]);
      setPairing(stored ? (JSON.parse(stored) as StoredPairing) : null);
      setSyncStats(stats);
      setQueueSize(queue);
      setBgSyncActive(bgActive);
      // BACKLOG-2209 + BACKLOG-2214: proactively detect that SMS access is NOT
      // granted — revoked after pairing (2209) OR never granted / skipped in
      // onboarding (2214) — so the one "SMS access needed" banner appears WITHOUT
      // a manual "Sync Now". On non-Android `readSms` is 'unavailable' → false.
      const smsGranted = smsPerm.readSms === 'granted';
      setSmsNotGranted(!smsGranted);
      // BACKLOG-2214: once granted, remember it so a later denied state reads as a
      // revocation (recovery framing) rather than never-granted (setup framing).
      if (smsGranted && grantedOnce !== 'true') {
        void AsyncStorage.setItem(SMS_GRANTED_ONCE_KEY, 'true');
      }
      setSmsEverGranted(smsGranted || grantedOnce === 'true');

      // Fire the guarded battery-optimization prompt if sync has gone stale.
      void maybePromptBatteryOptimization(stats, !!stored);
    } catch (error) {
      console.error('[Home] Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }, [maybePromptBatteryOptimization]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  useFocusEffect(
    useCallback(() => {
      loadAllData();
    }, [loadAllData]),
  );

  // BACKLOG-2209: re-check SMS permission (and refresh sync stats) whenever the
  // app returns to the foreground. useFocusEffect does NOT fire on an AppState
  // background→active transition (the home screen stays "focused"), so returning
  // from Android Settings — where the user just revoked OR re-granted SMS access
  // — would otherwise not update the banner. This coordinates with the
  // BACKLOG-2204 AppState catch-up sync (which resumes syncing on re-grant): here
  // we refresh the UI so the revocation banner appears on revoke and clears on
  // re-grant.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') {
        void loadAllData();
      }
    });
    return () => sub.remove();
  }, [loadAllData]);

  // -------------------------------------------------------
  // Pairing
  // -------------------------------------------------------

  const savePairing = async (data: PairingData): Promise<boolean> => {
    // BACKLOG-2224: account-match pre-check BEFORE persisting or sending
    // anything (covers the re-pair / reconnect path too). Abort if this phone is
    // signed into a different Keepr account than the desktop.
    const match = await checkDesktopAccountMatch(data.desktopUserIdHash);
    if (!match.ok) {
      const { title, body } = accountMatchMessage(match.reason ?? 'account_mismatch');
      Alert.alert(title, body);
      return false;
    }

    // --- BACKLOG-1456: Auto-ping on pair + auto-first-sync ---
    // WARNING: This auto-ping/auto-sync logic must be preserved if this screen
    // is rewritten (BACKLOG-1463 pairing screen redesign).

    // Step 1: register with the desktop FIRST so a reachability/account failure
    // is surfaced (BACKLOG-2212) instead of swallowed. registerDevice never
    // throws and enforces its own bounded timeout. We persist the pairing (and
    // flip the UI to "connected") ONLY after the desktop acknowledges it, so a
    // failed re-pair neither reports false success nor clobbers a previously
    // working pairing.
    let regResult: Awaited<ReturnType<typeof registerDevice>>;
    try {
      regResult = await registerDevice({
        ip: data.ip,
        port: data.port,
        secret: data.secret,
        deviceId: data.deviceName,
      });
    } catch (error) {
      // Defensive: registerDevice maps errors to results, but never trust it to.
      console.warn('[Pairing] Device registration error:', error);
      regResult = { success: false, errorType: 'unknown' };
    }

    if (!regResult.success) {
      // BACKLOG-2212: surface the failure instead of swallowing it and falsely
      // reporting "Paired Successfully". A reachability / generic failure offers
      // a Retry (re-attempts the same scanned QR); an account rejection is
      // guidance only.
      console.warn('[Pairing] Device registration failed:', regResult.error);
      const { title, body, retryable } = pairFailureMessage(regResult);
      if (retryable) {
        Alert.alert(title, body, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Retry', onPress: () => { void savePairing(data); } },
        ]);
      } else {
        Alert.alert(title, body);
      }
      return false;
    }

    console.log('[Pairing] Device registered with desktop');
    // BACKLOG-2210: adopt the desktop-minted device identity so every phone is
    // unique (no deviceName collision). On this re-pair path the stored
    // fingerprints may be from a PRIOR pairing, so forcing a FULL contact sync is
    // what lets the desktop stale-delete the old-id rows and re-key under the new
    // id (no duplicate contacts).
    const storedPairing: StoredPairing = {
      ...data,
      pairedAt: new Date().toISOString(),
      ...(regResult.deviceId ? { deviceId: regResult.deviceId } : {}),
    };
    await AsyncStorage.setItem(
      PAIRING_STORAGE_KEY,
      JSON.stringify(storedPairing),
    );
    setPairing(storedPairing);
    if (regResult.deviceId) {
      await forceFullContactResync();
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

    return true;
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

        const paired = await savePairing(data);
        // BACKLOG-2224: only celebrate when pairing actually completed; an
        // account-mismatch pre-check aborts with its own alert.
        if (paired) {
          Alert.alert(
            'Paired Successfully',
            `Connected to ${data.deviceName} at ${data.ip}:${data.port}`,
          );
        }
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
        // BACKLOG-2296: `phone_offline` (the phone has no Wi-Fi) gets its own
        // title, distinct from a desktop that is closed/unreachable — the two
        // used to be conflated under one "Desktop Not Running" message.
        const title =
          result.errorType === 'phone_offline'
            ? "You're Not on Wi-Fi"
            : result.errorType === 'timeout'
              ? 'Connection Timed Out'
              : result.errorType === 'network_after_connect'
                ? 'Transfer Failed'
                : result.errorType === 'connection_refused'
                  ? "Can't Reach Keepr"
                  : 'Sync Issue';
        Alert.alert(title, result.error);
      } else if (result.readError) {
        // BACKLOG-2206: a read failure is NOT "all synced" — show an actionable
        // read-error alert instead of a false "Up to Date". Checked after the
        // network error (an unreachable desktop is the more actionable fix) but
        // before the success branch.
        const { title, body } = smsReadErrorMessage(result.readError);
        Alert.alert(title, body);
      } else {
        // BACKLOG-2208: report NEW/CHANGED contacts (symmetric with messages),
        // not the raw transmitted count. `newContacts` is only credited when the
        // batch actually synced (contactsSynced > 0), so a failed contact send
        // never shows a false "N new contacts", and a periodic full re-send with
        // nothing actually new reads "Up to Date" rather than re-announcing the
        // whole address book.
        const newContactsSynced =
          result.contactsSynced > 0 ? result.newContacts : 0;

        if (result.sentMessages > 0 || newContactsSynced > 0) {
          const messagePart = `${result.sentMessages} message${result.sentMessages !== 1 ? 's' : ''}`;
          const contactPart = `${newContactsSynced} new contact${newContactsSynced !== 1 ? 's' : ''}`;
          Alert.alert(
            'Sync Complete',
            `Sent ${messagePart} and ${contactPart} to desktop.`,
          );
        } else if (
          result.newMessages === 0 &&
          result.sentMessages === 0 &&
          newContactsSynced === 0
        ) {
          Alert.alert('Up to Date', 'Nothing new to sync.');
        }
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

  // BACKLOG-2204: deep-link the user to battery-optimization settings so they
  // can exempt Keepr Companion. Falls back to written instructions if the
  // Android settings action is unavailable on this device.
  const handleFixBackgroundSync = useCallback(async (): Promise<void> => {
    const opened = await openBatteryOptimizationSettings();
    if (!opened) {
      Alert.alert(
        'Allow background activity',
        'Open your phone Settings > Apps > Keepr Companion > Battery, then allow background activity (remove battery optimization) so texts keep syncing while your phone is idle.',
      );
    }
  }, []);

  // BACKLOG-2206: open the app settings so the user can re-grant SMS permission,
  // which is the most common cause of a read failure.
  const handleFixReadPermission = useCallback(async (): Promise<void> => {
    await Linking.openSettings();
  }, []);

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
          showWordmark
          rightElement={headerAvatar}
          topInset={insets.top}
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
        <NavBarFooter />
        <SupportButton />
      </View>
    );
  }

  // -------------------------------------------------------
  // Render: Paired / Home
  // -------------------------------------------------------

  const pairedDate = new Date(pairing.pairedAt);

  // BACKLOG-2204: staleness signal for the home screen. Prefer the
  // "reached-desktop" timestamp; fall back to the message-send timestamp for
  // installs upgraded before lastSuccessfulSyncAt existed.
  const lastSyncAt =
    syncStats?.lastSuccessfulSyncAt ?? syncStats?.lastSyncTime ?? null;
  const freshness = getSyncFreshness(lastSyncAt);

  // BACKLOG-2206 + BACKLOG-2209 + BACKLOG-2214: ONE coherent "SMS access needed" /
  // read-error banner, fed from a SINGLE source (no competing surfaces). Priority:
  //   1) a LIVE-detected SMS-permission gap (proactive) — SMS access NOT granted,
  //      whether never granted / skipped in onboarding (BACKLOG-2214) OR revoked
  //      in Android Settings after pairing (BACKLOG-2209). Shown even without a
  //      manual sync, and also caught proactively at the start of every sync cycle
  //      in backgroundSync via the SAME permission_denied path. The copy adapts to
  //      the cause (setup vs recovery) but it is the SAME banner + "Open Settings"
  //      CTA, never a second surface.
  //   2) otherwise a NON-permission read failure from the last manual sync
  //      (BACKLOG-2206: query / parse / missing-module errors).
  // A live-GRANTED permission SUPPRESSES a stale `permission_denied` left over
  // from an earlier manual sync, so granting clears the banner (recovery) instead
  // of leaving it stuck until the next manual "Sync Now". A persistently-failing
  // read ALSO surfaces via the 2204 staleness banner (a read failure never
  // advances `lastSuccessfulSyncAt`), so this stays the immediate, actionable
  // signal rather than a competing banner system.
  const smsBanner: { title: string; body: string } | null = smsNotGranted
    ? smsPermissionBannerCopy(smsEverGranted ? 'revoked' : 'never_granted')
    : lastSyncResult?.readError &&
        lastSyncResult.readError.reason !== 'permission_denied'
      ? smsReadErrorMessage(lastSyncResult.readError)
      : null;

  // BACKLOG-2296: persistent "sync disconnected" banner. Derived from the last
  // sync result so it survives across the session until a successful sync clears
  // it. `syncDisconnection` returns null unless the last sync failed for a
  // connectivity reason — a 403 account rejection (server_error, 2284), a read
  // error, or a success never render this banner. The cause decides the copy and
  // whether the Re-connect CTA is offered (desktop-unreachable only).
  const disconnection = lastSyncResult
    ? syncDisconnection(lastSyncResult)
    : null;

  return (
    <View style={styles.screen}>
      <Header
        title="Keepr Companion"
        showWordmark
        rightElement={headerAvatar}
        topInset={insets.top}
      />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        style={styles.scrollView}
      >
        {/* Status */}
        <View style={styles.statusSection}>
          <StatusBadge status="connected" label="Paired" />
        </View>

        {/* Sync-disconnected banner (BACKLOG-2296): the last sync couldn't reach
            the desktop. The cause is distinguished — (a) the desktop app is
            closed/unreachable while the phone IS on Wi-Fi (offers a Re-connect
            CTA that re-runs the guided pair flow), vs (b) the phone itself is off
            Wi-Fi (guidance only; reconnecting Wi-Fi is the fix). A 403 account
            rejection never reaches here (see syncDisconnection). Danger palette,
            reusing the same banner primitive as the read-error surface. */}
        {disconnection && (
          <View style={styles.disconnectedBanner} accessibilityRole="alert">
            <Text style={styles.disconnectedTitle}>{disconnection.title}</Text>
            <Text style={styles.disconnectedBody}>{disconnection.body}</Text>
            {disconnection.showReconnect && (
              <Button
                title="Re-connect"
                variant="outline"
                onPress={handleStartScanning}
                fullWidth
              />
            )}
          </View>
        )}

        {/* Staleness warning (BACKLOG-2204): makes a silently-killed background
            sync visible, with a one-tap fix for Android battery optimization. */}
        {freshness.status === 'stale' && (
          <View style={styles.staleBanner} accessibilityRole="alert">
            <Text style={styles.staleTitle}>Sync may be behind</Text>
            <Text style={styles.staleBody}>
              {`Last successful sync ${formatRelativeTime(lastSyncAt).toLowerCase()}. Android battery optimization can pause background syncing while your phone is idle. Allow Keepr to run in the background, or open the app to catch up.`}
            </Text>
            <Button
              title="Fix background sync"
              variant="outline"
              onPress={handleFixBackgroundSync}
              fullWidth
            />
          </View>
        )}

        {/* "SMS access needed" / read-error banner (BACKLOG-2206 + 2209 + 2214):
            SMS access not granted (skipped in onboarding OR revoked) or a failed
            SMS read is surfaced here instead of a false "all synced". ONE surface
            with a grant / re-grant "Open Settings" CTA; the copy adapts to the
            cause. Distinct from the amber staleness banner — this is the immediate,
            actionable signal. */}
        {smsBanner && (
          <View style={styles.readErrorBanner} accessibilityRole="alert">
            <Text style={styles.readErrorTitle}>{smsBanner.title}</Text>
            <Text style={styles.readErrorBody}>{smsBanner.body}</Text>
            <Button
              title="Open Settings"
              variant="outline"
              onPress={handleFixReadPermission}
              fullWidth
            />
          </View>
        )}

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
            value={formatRelativeTime(lastSyncAt)}
            valueColor={
              freshness.status === 'stale' ? colors.warning[600] : undefined
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
            {/* BACKLOG-2208: symmetric with "New Messages" above — how many
                contacts were genuinely new/changed this cycle. */}
            <CardRow
              label="New Contacts"
              value={String(lastSyncResult.newContacts ?? 0)}
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
      <NavBarFooter />
      <SupportButton />
    </View>
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

  // Staleness warning banner (BACKLOG-2204) — amber, matches the warning palette.
  staleBanner: {
    width: '100%',
    backgroundColor: colors.warning[50],
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.warning[400],
    padding: spacing[4],
    marginBottom: spacing[4],
  },
  staleTitle: {
    ...textStyles.label,
    color: colors.warning[600],
    fontWeight: '700',
    marginBottom: spacing[1],
  },
  staleBody: {
    ...textStyles.caption,
    color: colors.gray[700],
    marginBottom: spacing[3],
  },

  // Read-error banner (BACKLOG-2206) — red/danger palette to distinguish a
  // failed SMS read from the amber "sync may be behind" staleness warning.
  readErrorBanner: {
    width: '100%',
    backgroundColor: colors.danger[50],
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.danger[400],
    padding: spacing[4],
    marginBottom: spacing[4],
  },
  readErrorTitle: {
    ...textStyles.label,
    color: colors.danger[600],
    fontWeight: '700',
    marginBottom: spacing[1],
  },
  readErrorBody: {
    ...textStyles.caption,
    color: colors.gray[700],
    marginBottom: spacing[3],
  },
  // Sync-disconnected banner (BACKLOG-2296) — danger palette, same visual
  // primitive as the read-error banner, distinguishing desktop-down vs phone
  // offline with a cause-appropriate Re-connect CTA.
  disconnectedBanner: {
    width: '100%',
    backgroundColor: colors.danger[50],
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.danger[400],
    padding: spacing[4],
    marginBottom: spacing[4],
  },
  disconnectedTitle: {
    ...textStyles.label,
    color: colors.danger[600],
    fontWeight: '700',
    marginBottom: spacing[1],
  },
  disconnectedBody: {
    ...textStyles.caption,
    color: colors.gray[700],
    marginBottom: spacing[3],
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
