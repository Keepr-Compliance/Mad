import { useState, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Linking,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  requestSmsPermissions,
  requestContactsPermissions,
  checkSmsPermissions,
  checkContactsPermissions,
} from '../../services/permissions';
import type {
  SmsPermissionResult,
  ContactsPermissionResult,
} from '../../services/permissions';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import { Button } from '../../components/ui';

export default function PermissionsScreen(): React.JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [smsResult, setSmsResult] = useState<SmsPermissionResult | null>(null);
  const [contactsResult, setContactsResult] = useState<ContactsPermissionResult | null>(null);
  const [attempted, setAttempted] = useState(false);

  const handleRequestPermissions = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      // Request permissions with a 10-second timeout per request
      const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
        Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

      const smsFallback: SmsPermissionResult = { readSms: 'denied', receiveSms: 'denied', allGranted: false };
      const contactsFallback: ContactsPermissionResult = { readContacts: 'denied', granted: false };

      // BACKLOG-1483: Request SEQUENTIALLY — Android can only show one permission dialog at a time.
      // Promise.all caused the second dialog (contacts) to be silently dropped.
      const sms = await withTimeout(requestSmsPermissions(), 10000, smsFallback);
      setSmsResult(sms);

      const contacts = await withTimeout(requestContactsPermissions(), 10000, contactsFallback);
      setContactsResult(contacts);
      setAttempted(true);

      // If all permissions granted, auto-advance to pair-device
      // BACKLOG-1473: permissions is now step 1, pair-device is step 2
      if (sms.allGranted && contacts.granted) {
        router.replace('/onboarding/pair-device');
      }
    } catch (error) {
      console.error('[Onboarding] Permission request error:', error);
      setAttempted(true);
    } finally {
      setLoading(false);
    }
  }, [router]);

  const handleContinueAnyway = useCallback((): void => {
    // BACKLOG-1473: Skip to pair-device (step 2) instead of first-sync
    router.replace('/onboarding/pair-device');
  }, [router]);

  const handleOpenSettings = useCallback((): void => {
    if (Platform.OS === 'android') {
      Linking.openSettings();
    }
  }, []);

  const handleCheckPermissions = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const [sms, contacts] = await Promise.all([
        checkSmsPermissions(),
        checkContactsPermissions(),
      ]);
      setSmsResult(sms);
      setContactsResult(contacts);

      if (sms.allGranted && contacts.granted) {
        router.replace('/onboarding/pair-device');
      }
    } finally {
      setLoading(false);
    }
  }, [router]);

  // BACKLOG-2196: `allGranted` MUST be declared before it is read below.
  // Previously it was declared after `hasDeniedPermissions`, which caused a
  // temporal-dead-zone `ReferenceError: Cannot access 'allGranted' before
  // initialization` under Hermes the instant `attempted` flipped true (i.e. as
  // soon as the user denied/partially granted) — crashing the recovery screen.
  const allGranted =
    smsResult?.allGranted === true && contactsResult?.granted === true;

  const hasBlockedPermissions =
    smsResult?.readSms === 'never_ask_again' ||
    smsResult?.receiveSms === 'never_ask_again' ||
    contactsResult?.readContacts === 'never_ask_again';

  // Show Open Settings for ANY denied permissions (not just permanently blocked)
  const hasDeniedPermissions = attempted && !allGranted;

  return (
    <View style={styles.screen}>
      {/* Step indicator */}
      <View style={styles.stepIndicator}>
        <Text style={styles.stepText}>Step 1 of 3</Text>
      </View>

      <View style={styles.content}>
        <Text style={styles.stepIcon}>{'🔐'}</Text>
        <Text style={styles.title}>App Permissions</Text>
        <Text style={styles.description}>
          Keepr Companion needs access to your SMS messages and contacts to sync
          them with the desktop app.
        </Text>

        {/* Permission items */}
        <View style={styles.permissionsCard}>
          <PermissionItem
            label="Read SMS"
            description="Read messages from your phone"
            status={smsResult?.readSms ?? null}
          />
          <View style={styles.itemDivider} />
          <PermissionItem
            label="Receive SMS"
            description="Get notified of new messages"
            status={smsResult?.receiveSms ?? null}
          />
          <View style={styles.itemDivider} />
          <PermissionItem
            label="Contacts"
            description="Sync contacts with desktop app"
            status={contactsResult?.readContacts ?? null}
          />
        </View>

        {/* Actions */}
        {!attempted ? (
          <Button
            title="Grant Permissions"
            onPress={handleRequestPermissions}
            loading={loading}
            disabled={loading}
            size="lg"
            fullWidth
          />
        ) : allGranted ? (
          <Button
            title="Continue"
            onPress={() => router.replace('/onboarding/pair-device')}
            size="lg"
            fullWidth
          />
        ) : hasDeniedPermissions ? (
          <View style={styles.blockedSection}>
            <Text style={styles.blockedText}>
              {hasBlockedPermissions
                ? 'Some permissions were permanently denied. Please enable them in your device settings.'
                : 'Some permissions were not granted. You can enable them in your device settings or continue without them.'}
            </Text>
            <Button
              title="Open Settings"
              onPress={handleOpenSettings}
              size="lg"
              fullWidth
            />
            <View style={styles.buttonSpacer} />
            <Button
              title="I Updated Settings"
              variant="outline"
              onPress={handleCheckPermissions}
              loading={loading}
              size="lg"
              fullWidth
            />
            <View style={styles.buttonSpacer} />
            <Button
              title="Skip for Now"
              variant="secondary"
              onPress={handleContinueAnyway}
              size="sm"
              fullWidth
            />
          </View>
        ) : (
          <View style={styles.blockedSection}>
            <Button
              title="Try Again"
              onPress={handleRequestPermissions}
              loading={loading}
              disabled={loading}
              size="lg"
              fullWidth
            />
            <View style={styles.buttonSpacer} />
            <Button
              title="Skip for Now"
              variant="secondary"
              onPress={handleContinueAnyway}
              size="sm"
              fullWidth
            />
          </View>
        )}
      </View>
    </View>
  );
}

// ============================================
// Permission Item Sub-Component
// ============================================

function PermissionItem({
  label,
  description,
  status,
}: {
  label: string;
  description: string;
  status: string | null;
}): React.JSX.Element {
  const statusColor =
    status === 'granted'
      ? colors.success[600]
      : status === 'never_ask_again'
        ? colors.danger[500]
        : status === 'denied'
          ? colors.warning[500]
          : colors.gray[400];

  const statusLabel =
    status === 'granted'
      ? 'Granted'
      : status === 'never_ask_again'
        ? 'Blocked'
        : status === 'denied'
          ? 'Denied'
          : 'Not requested';

  return (
    <View style={styles.permissionItem}>
      <View style={styles.permissionInfo}>
        <Text style={styles.permissionLabel}>{label}</Text>
        <Text style={styles.permissionDescription}>{description}</Text>
      </View>
      <Text style={[styles.permissionStatus, { color: statusColor }]}>
        {statusLabel}
      </Text>
    </View>
  );
}

// ============================================
// Styles
// ============================================

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
  permissionsCard: {
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
  permissionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing[3],
  },
  permissionInfo: {
    flex: 1,
    marginRight: spacing[3],
  },
  permissionLabel: {
    ...textStyles.label,
    color: colors.gray[900],
  },
  permissionDescription: {
    ...textStyles.caption,
    color: colors.gray[400],
    marginTop: 2,
  },
  permissionStatus: {
    ...textStyles.label,
  },
  itemDivider: {
    height: 1,
    backgroundColor: colors.gray[100],
  },
  blockedSection: {
    width: '100%',
  },
  blockedText: {
    ...textStyles.caption,
    color: colors.gray[500],
    textAlign: 'center',
    marginBottom: spacing[4],
  },
  buttonSpacer: {
    height: spacing[3],
  },
});
