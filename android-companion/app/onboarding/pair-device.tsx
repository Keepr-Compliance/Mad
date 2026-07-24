import { useState, useCallback } from 'react';
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
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import { Button } from '../../components/ui';

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

export default function PairDeviceScreen(): React.JSX.Element {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pairing, setPairing] = useState(false);

  const savePairing = async (data: PairingData): Promise<void> => {
    setPairing(true);
    try {
      const storedPairing: StoredPairing = {
        ...data,
        pairedAt: new Date().toISOString(),
      };
      await AsyncStorage.setItem(
        PAIRING_STORAGE_KEY,
        JSON.stringify(storedPairing),
      );

      // Register with the desktop app so it shows "Connected"
      try {
        const regResult = await registerDevice({
          ip: data.ip,
          port: data.port,
          secret: data.secret,
          deviceId: data.deviceName,
        });
        if (regResult.success) {
          console.log('[Onboarding] Device registered with desktop');
        } else {
          console.warn('[Onboarding] Device registration failed:', regResult.error);
        }
      } catch (error) {
        console.warn('[Onboarding] Device registration error (non-fatal):', error);
      }

      // Move to the next onboarding step (first-sync)
      // BACKLOG-1473: pair-device is now step 2, next is first-sync (step 3)
      router.replace('/onboarding/first-sync');
    } catch (error) {
      Alert.alert(
        'Pairing Failed',
        error instanceof Error ? error.message : 'Failed to save pairing data',
      );
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
        <Text style={styles.stepText}>Step 2 of 3</Text>
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
