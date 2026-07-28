import { useState, useCallback, useEffect, useRef } from 'react';
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
import { smsReadErrorMessage } from '../../services/smsReader';
import type { SyncErrorType } from '../../types/sync';
import { colors } from '../../theme/colors';
import { textStyles } from '../../theme/typography';
import { borderRadius, spacing } from '../../theme/spacing';
import { Button, Card, CardDivider, CardRow } from '../../components/ui';

const ONBOARDING_COMPLETE_KEY = '@keepr/onboarding-complete';

/**
 * Hard-timeout bound for the first sync (BACKLOG-2211).
 *
 * The first-sync screen previously showed a bare, indefinite spinner while
 * `performSync` ran. `performSync` has no wall-clock cap on its network reads
 * and sends, so a stalled read (desktop slow/unreachable mid-transfer, a large
 * backlog, a wedged state) stranded the user on "Step 3 of 3" with no escape —
 * force-quitting just re-enters onboarding. After this bound we stop presenting
 * an indefinite spinner and surface an escape UI (Continue to App / Keep
 * Waiting). We NEVER cancel the in-flight sync — it keeps running (and, via
 * `startBackgroundSync`, in the background); the timeout only unblocks the UI.
 *
 * Injectable via the optional `timeoutMs` prop purely so tests can drive the
 * timeout deterministically without fake timers; production always uses this
 * default.
 */
const FIRST_SYNC_TIMEOUT_MS = 30_000;

interface FirstSyncScreenProps {
  /** Hard-timeout bound in ms. Defaults to {@link FIRST_SYNC_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export default function FirstSyncScreen({
  timeoutMs = FIRST_SYNC_TIMEOUT_MS,
}: FirstSyncScreenProps = {}): React.JSX.Element {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncOperationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<SyncErrorType | undefined>(undefined);
  const [autoSyncStarted, setAutoSyncStarted] = useState(false);
  // BACKLOG-2211: true once the hard timeout fires while a sync is still in
  // flight. Only meaningful while `syncing` — a resolved sync (success OR
  // genuine error) always takes precedence over the timeout escape UI.
  const [timedOut, setTimedOut] = useState(false);

  // Live handle for the hard-timeout timer so we can clear/re-arm it, plus a
  // mounted guard so an in-flight `performSync` that resolves AFTER the user
  // skipped into the app doesn't setState on an unmounted screen (and, crucially,
  // isn't cancelled — skipping only unblocks the UI; the sync runs to completion).
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  /** Arm (or re-arm) the hard-timeout timer for the current sync attempt. */
  const armTimeout = useCallback((): void => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setTimedOut(false);
    timeoutRef.current = setTimeout(() => {
      // Only escalate if a sync is still running (guarded by `syncing` at render
      // time). If the sync already resolved, `syncing` is false and the timeout
      // UI is never shown.
      if (isMountedRef.current) setTimedOut(true);
    }, timeoutMs);
  }, [timeoutMs]);

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
    // Arm the hard timeout for this attempt (BACKLOG-2211). Cleared in `finally`
    // (or on unmount) so a fast sync never shows the escape UI.
    armTimeout();

    try {
      // Start background sync service first
      await startBackgroundSync();
      console.log('[Onboarding] Background sync started');

      // Then perform the initial sync.
      //
      // BACKLOG-2200/2201: performSync now returns `skipped: true` when another
      // sync already holds the cross-context lock (during onboarding, the
      // auto-sync-on-pair fired from the home screen can be that holder). A
      // skipped result carries zeros and is NOT a completed sync — rendering it
      // would show a false "Sync Complete / Sent 0 messages". So we wait briefly
      // for the in-flight run to release the lock and re-attempt, up to a small
      // bound, instead of surfacing the skip as a terminal state.
      const MAX_SKIP_RETRIES = 5;
      const SKIP_RETRY_DELAY_MS = 1500;
      let result = await performSync();
      for (
        let attempt = 0;
        result.skipped && attempt < MAX_SKIP_RETRIES;
        attempt++
      ) {
        console.log(
          `[Onboarding] First sync skipped (another sync in progress) — retrying (${attempt + 1}/${MAX_SKIP_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, SKIP_RETRY_DELAY_MS));
        result = await performSync();
      }

      // If the user already skipped into the app the screen is unmounted — do
      // NOT setState (and never touch the still-running sync).
      if (!isMountedRef.current) return;

      setSyncResult(result);
      console.log(
        `[Onboarding] First sync: ${result.sentMessages} msgs, ${result.contactsSynced} contacts${result.skipped ? ' (still in progress elsewhere)' : ''}`,
      );

      if (result.error) {
        setError(result.error);
        setErrorType(result.errorType);
      } else if (result.readError) {
        // BACKLOG-2206: a read failure (permission/provider error) is not a
        // success — surface its actionable message rather than "Sync Complete".
        setError(smsReadErrorMessage(result.readError).body);
        setErrorType('unknown');
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      const message = err instanceof Error ? err.message : 'Sync failed';
      setError(message);
      setErrorType('unknown');
      console.error('[Onboarding] First sync error:', err);
    } finally {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (isMountedRef.current) {
        setSyncing(false);
        setTimedOut(false);
      }
    }
  };

  const handleComplete = useCallback(async (): Promise<void> => {
    // Mark onboarding as complete
    await AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
    // Navigate to the main app
    router.replace('/(main)/home');
  }, [router]);

  // BACKLOG-2211: "Skip for now" / "Continue to App" — unblock the UI past the
  // first-sync gate WITHOUT cancelling the sync. The background sync task is
  // already registered (startBackgroundSync above) and any in-flight performSync
  // keeps running to completion; the home screen then surfaces sync progress /
  // staleness / last-sync health (BACKLOG-2204/2201/2206). We deliberately do
  // NOT call stopBackgroundSync / unpair here.
  const handleSkip = useCallback((): void => {
    console.log(
      '[Onboarding] First sync skipped by user — continuing to app; sync keeps running in the background',
    );
    void handleComplete();
  }, [handleComplete]);

  // BACKLOG-2211: dismiss the timeout escape UI and keep waiting on the same
  // in-flight sync — just re-arm the hard timeout. Does not restart or cancel
  // the sync.
  const handleKeepWaiting = useCallback((): void => {
    armTimeout();
  }, [armTimeout]);

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

  // A `skipped` result (another sync held the lock and our bounded retries were
  // exhausted) is NOT a success — treat it as an issue so we never render a
  // false "Sync Complete" for a zero-transfer skip (BACKLOG-2200/2201).
  const isSyncError =
    (!!error && !syncResult) ||
    syncResult?.desktopReachable === false ||
    syncResult?.skipped === true ||
    // BACKLOG-2206: a failed SMS read (desktop reachable, but the read errored)
    // is NOT a success — treat it as the error state so we never render a false
    // "Sync Complete" for a cycle that read nothing due to an error.
    !!syncResult?.readError;

  // -------------------------------------------------------
  // Render: Syncing in progress
  // -------------------------------------------------------

  if (syncing) {
    // BACKLOG-2211: hard timeout tripped while the sync is still running. Replace
    // the indefinite spinner with an escape UI so the user is never stranded on
    // step 3 of 3. The sync itself is NOT cancelled — it keeps running (and in
    // the background); "Continue to App" just unblocks the flow, "Keep Waiting"
    // re-arms the timeout on the same in-flight sync.
    if (timedOut) {
      return (
        <View style={styles.screen}>
          <View style={styles.stepIndicator}>
            <Text style={styles.stepText}>Step 3 of 3</Text>
          </View>
          <View style={styles.content}>
            <Text style={styles.stepIcon}>{'⏳'}</Text>
            <Text style={styles.title}>Taking longer than expected</Text>
            <Text style={styles.description}>
              Your first sync is still running. This can happen with a large
              message history or a slow network.
            </Text>
            <Text style={styles.subdescription}>
              You can continue to the app now — syncing keeps running in the
              background and you&apos;ll see progress on the home screen.
            </Text>
            <View style={styles.actions}>
              <Button
                title="Continue to App"
                onPress={handleSkip}
                size="lg"
                fullWidth
              />
              <View style={styles.buttonSpacer} />
              <Button
                title="Keep Waiting"
                variant="outline"
                onPress={handleKeepWaiting}
                fullWidth
              />
            </View>
          </View>
        </View>
      );
    }

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
          {/* BACKLOG-2211: always-present escape hatch so the user is never
              trapped on the spinner, even before the hard timeout fires. Skipping
              does not cancel the sync — it keeps running in the background. */}
          <View style={styles.skipLink}>
            <Button
              title="Skip for now"
              variant="outline"
              size="sm"
              onPress={handleSkip}
            />
          </View>
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
            <Text style={styles.description}>
              {error ??
                syncResult?.error ??
                (syncResult?.skipped
                  ? 'A sync is already running. Tap Retry in a moment.'
                  : 'Sync did not complete.')}
            </Text>
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
  skipLink: {
    marginTop: spacing[8],
  },
});
