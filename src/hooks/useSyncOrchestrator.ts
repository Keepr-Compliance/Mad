/**
 * useSyncOrchestrator Hook
 *
 * React hook for consuming SyncOrchestrator state.
 * Provides reactive updates when sync state changes.
 *
 * Usage:
 * ```tsx
 * const { state, isRunning, requestSync } = useSyncOrchestrator();
 *
 * // Request a sync
 * requestSync(['contacts', 'emails', 'messages'], userId);
 *
 * // Check state
 * if (isRunning) {
 *   // Show progress UI
 * }
 * ```
 *
 * @module hooks/useSyncOrchestrator
 */

import { useState, useEffect, useCallback } from 'react';
import {
  syncOrchestrator,
  SyncOrchestratorState,
  SyncItem,
  SyncType,
  SyncRequest,
} from '../services/SyncOrchestratorService';

export interface UseSyncOrchestratorReturn {
  // State
  state: SyncOrchestratorState;
  isRunning: boolean;
  queue: SyncOrchestratorState['queue'];
  currentSync: SyncType | null;
  overallProgress: number;
  pendingRequest: SyncOrchestratorState['pendingRequest'];
  /** BACKLOG-2330: bumped each time an external sync is cancelled (removed). */
  externalCancelCount: number;

  // Actions
  requestSync: (types: SyncType[], userId: string, options?: SyncRequest['options']) => { started: boolean; needsConfirmation: boolean };
  forceSync: (types: SyncType[], userId: string, options?: SyncRequest['options']) => void;
  acceptPending: () => void;
  rejectPending: () => void;
  cancel: () => void;
  /**
   * BACKLOG-2776: mark a running sync as cancel-requested so every surface
   * reading its queue item freezes and relabels in the same tick as the click.
   * Acknowledgement only — the cancel itself goes to the main process by IPC.
   *
   * BACKLOG-2794: a press on a PENDING item registers a skip instead, and the
   * return value says which happened — `'running'` means the caller still owes
   * the cancel IPC, `'skipped'` means there is nothing running to send it to.
   */
  markCancelRequested: (type: SyncType) => 'running' | 'skipped' | 'none';
  /**
   * BACKLOG-2794: read a queue item from LIVE orchestrator state rather than
   * the subscribed copy, which is one render behind. Only decisions that race
   * the pending→running flip need this; rendering should use `queue`.
   */
  getQueueItem: (type: SyncType) => SyncItem | undefined;
}

/**
 * Hook for consuming SyncOrchestrator state in React components.
 * Automatically subscribes to state changes and provides convenience methods.
 */
export function useSyncOrchestrator(): UseSyncOrchestratorReturn {
  const [state, setState] = useState<SyncOrchestratorState>(syncOrchestrator.getState());

  // Subscribe to state changes
  useEffect(() => {
    return syncOrchestrator.subscribe(setState);
  }, []);

  // Convenience methods
  const requestSync = useCallback((types: SyncType[], userId: string, options?: SyncRequest['options']) => {
    return syncOrchestrator.requestSync({ types, userId, options });
  }, []);

  const forceSync = useCallback((types: SyncType[], userId: string, options?: SyncRequest['options']) => {
    syncOrchestrator.forceSync({ types, userId, options });
  }, []);

  const acceptPending = useCallback(() => {
    syncOrchestrator.acceptPendingRequest();
  }, []);

  const rejectPending = useCallback(() => {
    syncOrchestrator.rejectPendingRequest();
  }, []);

  const cancel = useCallback(() => {
    syncOrchestrator.cancel();
  }, []);

  const markCancelRequested = useCallback(
    (type: SyncType) => syncOrchestrator.markCancelRequested(type),
    []
  );

  const getQueueItem = useCallback(
    (type: SyncType) => syncOrchestrator.getQueueItem(type),
    []
  );

  return {
    // State
    state,
    isRunning: state.isRunning,
    queue: state.queue,
    currentSync: state.currentSync,
    overallProgress: state.overallProgress,
    pendingRequest: state.pendingRequest,
    externalCancelCount: state.externalCancelCount,

    // Actions
    requestSync,
    forceSync,
    acceptPending,
    rejectPending,
    cancel,
    markCancelRequested,
    getQueueItem,
  };
}

export default useSyncOrchestrator;
