import { useState, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Alert,
  Linking,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { registerDevice } from '../../services/syncService';
import { forceFullContactResync } from '../../services/contactSyncState';
import {
  checkDesktopAccountMatch,
  accountMatchMessage,
} from '../../services/accountMatch';
import { pairFailureMessage } from '../../services/pairingFeedback';
import {
  setOnboardingStep,
  completeOnboarding,
} from '../../services/onboardingProgress';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import { Button } from '../../components/ui';
import OnboardingSignOutLink from '../../components/ui/OnboardingSignOutLink';

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

export default function PairDeviceScreen(): React.JSX.Element {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState(false);

  // BACKLOG-2216: persist progress so an interruption resumes at this step.
  useEffect(() => {
    void setOnboardingStep('pair-device');
  }, []);

  const savePairing = async (data: PairingData): Promise<boolean> => {
    // BACKLOG-2224: account-match pre-check BEFORE persisting or sending
    // anything. If this phone is signed into a different Keepr account than the
    // desktop, abort immediately so no texts/contacts leak across accounts.
    const match = await checkDesktopAccountMatch(data.desktopUserIdHash);
    if (!match.ok) {
      const { title, body } = accountMatchMessage(match.reason ?? 'account_mismatch');
      Alert.alert(title, body);
      return false;
    }

    setPairing(true);
    try {
      // BACKLOG-2212: register with the desktop FIRST and surface any failure.
      // `registerDevice` maps every network/timeout/HTTP error to a result (it
      // never throws) and enforces its own bounded timeout, so a black-hole
      // desktop cannot hang the scanner. We persist the pairing ONLY after the
      // desktop acknowledges it — a failed attempt leaves no half-paired state
      // and never advances onboarding into a first-sync that cannot work.
      const regResult = await registerDevice({
        ip: data.ip,
        port: data.port,
        secret: data.secret,
        deviceId: data.deviceName,
      });

      if (!regResult.success) {
        // BACKLOG-2212: surface the failure instead of swallowing it and pushing
        // on to first-sync. A reachability/generic failure offers a Retry
        // (re-attempts the same scanned QR — no need to re-scan); an account
        // rejection is guidance only. The scanner is already closed, so we simply
        // stay on the pair step (never a stuck spinner, never a silent advance).
        console.warn('[Onboarding] Device registration failed:', regResult.error);
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

      console.log('[Onboarding] Device registered with desktop');
      // BACKLOG-2210: adopt the desktop-minted device identity so every phone is
      // unique (no deviceName collision). Persist it as the pairing identity and
      // force the next contact sync to be FULL so the desktop re-keys
      // android_sync contacts under the new id (clean re-key; message dedup is
      // content-hashed so it needs no reset).
      const storedPairing: StoredPairing = {
        ...data,
        pairedAt: new Date().toISOString(),
        ...(regResult.deviceId ? { deviceId: regResult.deviceId } : {}),
      };
      await AsyncStorage.setItem(
        PAIRING_STORAGE_KEY,
        JSON.stringify(storedPairing),
      );
      if (regResult.deviceId) {
        await forceFullContactResync();
      }

      // Move to the next onboarding step (first-sync)
      // BACKLOG-1473: pair-device is now step 2, next is first-sync (step 3)
      router.replace('/onboarding/first-sync');
      return true;
    } catch (error) {
      Alert.alert(
        'Pairing Failed',
        error instanceof Error ? error.message : 'Failed to save pairing data',
      );
      return false;
    } finally {
      setPairing(false);
    }
  };

  const handleBarCodeScanned = useCallback(
    async (result: { data: string }): Promise<void> => {
      if (!scanning || pairing) return;
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
      } catch {
        Alert.alert(
          'Invalid QR Code',
          'Could not read the QR code. Please try again with the QR code from the Keepr desktop application.',
        );
      }
    },
    [scanning, pairing],
  );

  /**
   * BACKLOG-2956: "Continue without a computer".
   *
   * Until now pair-device was the ONLY onboarding screen with no way forward and
   * no way back — permissions and first-sync both already ship "Skip for Now".
   * Three separate people hit the resulting dead end: a Play reviewer with only a
   * phone (who can never see the app work, the most likely rejection), the
   * founder after signing in with the wrong account, and a field tester whose
   * pairing kept failing. Their only escape was clearing app storage.
   *
   * This lands the user in the REAL app, unpaired — no demo mode, no sample data,
   * no fake content. `app/(main)/home.tsx` already renders a deliberate empty
   * state for an unpaired phone ("Not Paired" / "Pair with Keepr" / a working
   * Scan QR Code button), and that state is already exercised in production: a
   * sign-out clears the pairing, so re-login lands an onboarded user there today.
   * Pairing therefore stays one tap away from home.
   *
   * `completeOnboarding()` is AWAITED before navigating. The auth gate in
   * app/_layout.tsx treats "reached (main)" as proof the complete flag is
   * persisted; navigating first would race the gate, which would bounce the user
   * back into onboarding at the resumed step.
   */
  const handleContinueWithoutComputer = useCallback(async (): Promise<void> => {
    try {
      await completeOnboarding();
    } catch (error) {
      // Non-fatal: the gate's own re-check settles it, and the user is not
      // trapped either way. Never block the escape hatch on a storage write.
      console.error('[Onboarding] Failed to mark onboarding complete:', error);
    }
    router.replace('/(main)/home');
  }, [router]);

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
  // Render: QR Scanner active
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
  // Render: Instructions
  // -------------------------------------------------------

  return (
    <View style={styles.screen}>
      {/* Step indicator */}
      <View style={styles.stepIndicator}>
        <Text style={styles.stepText}>Step 3 of 4</Text>
      </View>

      <View style={styles.content}>
        <Text style={styles.stepIcon}>{'📱'}</Text>
        <Text style={styles.title}>Pair with Keepr</Text>
        <Text style={styles.description}>
          Open the Keepr desktop app and go to Settings {'->'} Companion Device.
          Scan the QR code displayed there to connect this phone.
        </Text>

        <View style={styles.stepsCard}>
          <View style={styles.stepRow}>
            <Text style={styles.stepNumber}>1</Text>
            <Text style={styles.stepLabel}>Open Keepr on your computer</Text>
          </View>
          <View style={styles.stepDivider} />
          <View style={styles.stepRow}>
            <Text style={styles.stepNumber}>2</Text>
            <Text style={styles.stepLabel}>Go to Settings {'>'} Companion Device</Text>
          </View>
          <View style={styles.stepDivider} />
          <View style={styles.stepRow}>
            <Text style={styles.stepNumber}>3</Text>
            <Text style={styles.stepLabel}>Scan the QR code shown on screen</Text>
          </View>
        </View>

        <Button
          title="Scan QR Code"
          onPress={handleStartScanning}
          loading={pairing}
          disabled={pairing}
          size="lg"
          fullWidth
        />

        <View style={styles.buttonSpacer} />

        {/* BACKLOG-2956: the escape hatch. Lands in the real app, unpaired. */}
        <Button
          title="Continue without a computer"
          variant="secondary"
          onPress={() => {
            void handleContinueWithoutComputer();
          }}
          disabled={pairing}
          size="sm"
          fullWidth
        />
        <Text style={styles.skipNote}>
          You can pair with your computer later from the home screen.
        </Text>

        <OnboardingSignOutLink />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.gray[50],
  },
  stepIndicator: {
    paddingTop: spacing[16],
    paddingBottom: spacing[2],
    alignItems: 'center',
  },
  stepText: {
    ...textStyles.caption,
    color: colors.primary[600],
    fontWeight: '600',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
    paddingBottom: spacing[12],
  },
  stepIcon: {
    fontSize: 48,
    marginBottom: spacing[5],
  },
  title: {
    ...textStyles.heading,
    color: colors.gray[900],
    textAlign: 'center',
    marginBottom: spacing[3],
  },
  description: {
    ...textStyles.body,
    color: colors.gray[600],
    textAlign: 'center',
    marginBottom: spacing[8],
  },
  stepsCard: {
    width: '100%',
    backgroundColor: colors.white,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.gray[200],
    padding: spacing[4],
    marginBottom: spacing[8],
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing[3],
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary[100],
    color: colors.primary[700],
    textAlign: 'center',
    lineHeight: 28,
    fontWeight: '700',
    fontSize: 14,
    marginRight: spacing[3],
    overflow: 'hidden',
  },
  stepLabel: {
    ...textStyles.body,
    color: colors.gray[700],
    flex: 1,
  },
  stepDivider: {
    height: 1,
    backgroundColor: colors.gray[100],
    marginLeft: 40,
  },
  buttonSpacer: {
    height: spacing[3],
  },
  skipNote: {
    ...textStyles.caption,
    color: colors.gray[500],
    textAlign: 'center',
    marginTop: spacing[2],
  },

  // Scanner styles
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
