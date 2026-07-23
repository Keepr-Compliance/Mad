import { useState, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import {
  startBackgroundSync,
  performSync,
} from '../../services/backgroundSync';
import type { SyncOperationResult } from '../../services/backgroundSync';
import type { SyncErrorType } from '../../types/sync';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import { Button, Card, CardDivider, CardRow } from '../../components/ui';

const ONBOARDING_COMPLETE_KEY = '@keepr/onboarding-complete';

export default function FirstSyncScreen(): React.JSX.Element {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncOperationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<SyncErrorType | undefined>(undefined);
  const [autoSyncStarted, setAutoSyncStarted] = useState(false);

  // Auto-start sync when screen mounts
  useEffect(() => {
    if (!autoSyncStarted) {
      setAutoSyncStarted(true);
      runFirstSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runFirstSync = async (): Promise<void> => {
    setSyncing(true);
    setError(null);
    setErrorType(undefined);
    setSyncResult(null);

    try {
      // Start background sync service first
      await startBackgroundSync();
      console.log('[Onboarding] Background sync started');

      // Then perform the initial sync
      const result = await performSync();
      setSyncResult(result);
      console.log(
        `[Onboarding] First sync: ${result.sentMessages} msgs, ${result.contactsSynced} contacts`,
      );

      if (result.error) {
        setError(result.error);
        setErrorType(result.errorType);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed';
      setError(message);
      setErrorType('unknown');
      console.error('[Onboarding] First sync error:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handleComplete = useCallback(async (): Promise<void> => {
    // Mark onboarding as complete
    await AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
    // Navigate to the main app
    router.replace('/(main)/home');
  }, [router]);

  const handleRetry = useCallback((): void => {
    runFirstSync();
  }, []);

  // -------------------------------------------------------
  // Derived state: is this an error / "looked successful but wasn't"?
  //
  // performSync (backgroundSync.ts) returns a POPULATED result object even when
  // nothing transferred: when not paired or the desktop is unreachable it sets
  // `desktopReachable: false` and an `error` string but STILL returns a result.
  // Because `syncResult` is then truthy, the old `error && !syncResult` guard
  // fell through to the success branch, showing a green ✅ "Sync Complete" for a
  // zero-transfer sync (BACKLOG-2201).
  //
  // `desktopReachable === false` is the definitive "nothing got through" signal
  // and covers BOTH false-success cases. We treat it — plus any thrown error —
  // as the error state. The genuine-partial case (desktop reachable but a send
  // failed mid-transfer: desktopReachable === true with an error) is intentionally
  // NOT flagged here, so it keeps its legitimate "Partially Synced" treatment.
  // -------------------------------------------------------

  const isSyncError =
    (!!error && !syncResult) || syncResult?.desktopReachable === false;

  // -------------------------------------------------------
  // Render: Syncing in progress
  // -------------------------------------------------------

  if (syncing) {
    return (
      <View style={styles.screen}>
        <View style={styles.stepIndicator}>
          <Text style={styles.stepText}>Step 3 of 3</Text>
        </View>
        <View style={styles.content}>
          <ActivityIndicator size="large" color={colors.primary[600]} />
          <Text style={styles.title}>First Sync</Text>
          <Text style={styles.description}>
            Syncing your messages and contacts with the desktop app. This may
            take a moment...
          </Text>
        </View>
      </View>
    );
  }

  // -------------------------------------------------------
  // Render: Sync complete (or error)
  // -------------------------------------------------------

  return (
    <View style={styles.screen}>
      <View style={styles.stepIndicator}>
        <Text style={styles.stepText}>Step 3 of 3</Text>
      </View>

      <View style={styles.content}>
        {isSyncError ? (
          <>
            <Text style={styles.stepIcon}>{'⚠️'}</Text>
            <Text style={styles.title}>Sync Issue</Text>
            <Text style={styles.description}>{error ?? syncResult?.error}</Text>
            <Text style={styles.subdescription}>
              {errorType === 'timeout'
                ? 'Large data transfers may be blocked on this network. Try your phone\'s mobile hotspot.'
                : errorType === 'network_after_connect'
                  ? 'The connection was interrupted during transfer. A different network or hotspot may help.'
                  : 'Make sure Keepr is open on your computer and both devices are on the same WiFi network.'}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.stepIcon}>{'✅'}</Text>
            <Text style={styles.title}>
              {syncResult?.error ? 'Partially Synced' : 'Sync Complete'}
            </Text>
            <Text style={styles.description}>
              {syncResult?.error
                ? 'Some data was synced but there were issues.'
                : 'Your device is connected and syncing with Keepr.'}
            </Text>
          </>
        )}

        {/* Sync results card */}
        {syncResult && (
          <Card title="Sync Results" style={styles.resultsCard}>
            <CardRow
              label="New Messages"
              value={String(syncResult.newMessages)}
            />
            <CardDivider />
            <CardRow
              label="Sent to Desktop"
              value={String(syncResult.sentMessages)}
            />
            <CardDivider />
            <CardRow
              label="Contacts Synced"
              value={String(syncResult.contactsSynced)}
            />
            <CardDivider />
            <CardRow
              label="Desktop Reachable"
              value={syncResult.desktopReachable ? 'Yes' : 'No'}
              valueColor={
                syncResult.desktopReachable
                  ? colors.success[600]
                  : colors.danger[500]
              }
            />
            {syncResult.error && (
              <>
                <CardDivider />
                <CardRow label="Note" value={syncResult.error} />
              </>
            )}
          </Card>
        )}

        {/* Actions.
            In the error state (nothing transferred) Retry is the primary action
            and "Continue Anyway" is the de-emphasized escape hatch, so a user
            whose sync actually failed isn't nudged straight past it (BACKLOG-2201).
            In the success / genuine-partial state, "Get Started" stays primary and
            Retry (when a partial error is present) is the secondary affordance. */}
        <View style={styles.actions}>
          {isSyncError ? (
            <>
              <Button
                title="Retry Sync"
                onPress={handleRetry}
                size="lg"
                fullWidth
              />
              <View style={styles.buttonSpacer} />
              <Button
                title="Continue Anyway"
                variant="outline"
                onPress={handleComplete}
                fullWidth
              />
            </>
          ) : (
            <>
              <Button
                title="Get Started"
                onPress={handleComplete}
                size="lg"
                fullWidth
              />
              {syncResult?.error && (
                <>
                  <View style={styles.buttonSpacer} />
                  <Button
                    title="Retry Sync"
                    variant="outline"
                    onPress={handleRetry}
                    fullWidth
                  />
                </>
              )}
            </>
          )}
        </View>
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
    marginTop: spacing[4],
    marginBottom: spacing[3],
  },
  description: {
    ...textStyles.body,
    color: colors.gray[600],
    textAlign: 'center',
    marginBottom: spacing[2],
  },
  subdescription: {
    ...textStyles.caption,
    color: colors.gray[400],
    textAlign: 'center',
    marginBottom: spacing[4],
  },
  resultsCard: {
    marginTop: spacing[4],
  },
  actions: {
    width: '100%',
    marginTop: spacing[6],
  },
  buttonSpacer: {
    height: spacing[3],
  },
});
