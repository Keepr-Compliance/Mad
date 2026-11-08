/**
 * useTermsHandlers Hook
 *
 * Manages terms acceptance and decline logic.
 * Extracted from useAuthFlow for single-responsibility decomposition.
 */

import { useCallback } from "react";
import { authService } from "@/services";
import logger from '../../../../utils/logger';

export interface UseTermsHandlersOptions {
  currentUserId: string | null;
  clearTermsRequirement: () => void;
  declineTerms: () => Promise<void>;
}

export function useTermsHandlers({
  currentUserId,
  clearTermsRequirement,
  declineTerms,
}: UseTermsHandlersOptions) {
  const handleAcceptTerms = useCallback(async (): Promise<void> => {
    try {
      // Always write to Supabase - it's the source of truth
      // Local DB will sync from Supabase when it initializes
      const userId = currentUserId;

      if (!userId) {
        throw new Error("No user ID available for terms acceptance");
      }

      const result = await authService.acceptTermsToSupabase(userId);

      if (result.success) {
        // Clear needsTermsAcceptance in AuthContext so WelcomeTerms modal closes
        clearTermsRequirement();
      } else {
        throw new Error(result.error || "Failed to accept terms");
      }
    } catch (error) {
      logger.error("[useAuthFlow] Failed to accept terms:", error);
      throw error;
    }
  }, [currentUserId, clearTermsRequirement]);

  const handleDeclineTerms = useCallback(async (): Promise<void> => {
    await declineTerms();
  }, [declineTerms]);

  return { handleAcceptTerms, handleDeclineTerms };
}
