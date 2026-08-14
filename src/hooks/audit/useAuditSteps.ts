/**
 * useAuditSteps Hook
 * Manages step navigation with validation gates for the audit transaction wizard.
 * Extracted from useAuditTransaction.ts (TASK-2261)
 *
 * 3-step flow:
 * - Step 1: Transaction details (address, type, dates)
 * - Step 2: Select contacts
 * - Step 3: Assign roles to selected contacts
 * In edit mode, saves directly from step 1 (no contact steps)
 */
import { useState, useCallback } from "react";
import {
  findContactsMissingRoles,
  missingRolesMessage,
  toRoleContactIds,
} from "../../utils/transactionContactRules";
import type { AddressData, ContactAssignments } from "./types";

interface UseAuditStepsProps {
  isEditing: boolean;
  addressData: AddressData;
  selectedContactIds: string[];
  contactAssignments: ContactAssignments;
  onSubmit: () => void;
  setError: (error: string | null) => void;
}

export interface UseAuditStepsReturn {
  step: number;
  handleNextStep: () => void;
  handlePreviousStep: () => void;
}

export function useAuditSteps({
  isEditing,
  addressData,
  selectedContactIds,
  contactAssignments,
  onSubmit,
  setError,
}: UseAuditStepsProps): UseAuditStepsReturn {
  const [step, setStep] = useState<number>(1);

  /**
   * Proceed to next step with validation
   */
  const handleNextStep = useCallback((): void => {
    if (step === 1) {
      if (!addressData.property_address.trim()) {
        setError("Property address is required");
        return;
      }
      if (!addressData.started_at) {
        setError("Transaction start date is required");
        return;
      }
      if (addressData.closed_at && addressData.started_at > addressData.closed_at) {
        setError("End date must be after start date");
        return;
      }
      setError(null);
      if (isEditing) {
        onSubmit();
      } else {
        setStep(2);
      }
    } else if (step === 2) {
      if (selectedContactIds.length === 0) {
        setError("Please select at least one contact");
        return;
      }
      setError(null);
      setStep(3);
    } else if (step === 3) {
      const roleIds = toRoleContactIds(contactAssignments);

      /**
       * BACKLOG-2680 — A CONTACT WHOSE ROLE WAS BLANKED WAS SILENTLY DROPPED.
       *
       * `ContactRoleRow` renders an empty `<option value="">`, so blanking a
       * role is a reachable, deliberate action. `handleRoleChange` then removes
       * the contact from its old role and does not reassign it, and
       * `useAuditSubmission` builds its payload from the ROLE MAP rather than
       * from `selectedContactIds` — so that contact produced no row. The deal
       * saved successfully with one of the chosen people missing, and the user
       * was told nothing.
       *
       * This is the rule Edit Contacts already shipped
       * (`EditContactsModal.handleSave`), IMPORTED rather than restated, so the
       * two surfaces cannot answer the same action with different sentences.
       * It runs BEFORE the Client check for the same reason: Edit Contacts
       * asks these two questions in this order.
       *
       * The alternative shape — persist the contact with a null role — was not
       * taken. `electron/utils/validation.ts` requires a non-empty role per
       * assignment, so it would have been a schema-and-IPC change rather than a
       * bug fix, and it would have made the two surfaces disagree in the other
       * direction.
       *
       * IT RE-DEFAULTS NOTHING. BACKLOG-2677's `defaultedContactIdsRef` exists
       * so a hand-cleared role is never handed Client back. This reports the
       * cleared role instead of overwriting it, so that guarantee is untouched.
       */
      const missingRoles = findContactsMissingRoles(selectedContactIds, roleIds);
      if (missingRoles.length > 0) {
        setError(missingRolesMessage(missingRoles.length));
        return;
      }

      // THERE IS NO "AT LEAST ONE CLIENT" GATE HERE ANY MORE (BACKLOG-2683).
      // The founder deleted the requirement on 13 Aug: a deal may be saved with
      // nobody holding the Client role. The role-less check above stays — every
      // contact must be classified as something; none of them has to be the
      // Client.
      setError(null);
      onSubmit();
    }
  }, [step, addressData.property_address, addressData.started_at, addressData.closed_at, selectedContactIds, contactAssignments, onSubmit, isEditing]);

  /**
   * Go back to previous step
   */
  const handlePreviousStep = useCallback((): void => {
    setError(null);
    setStep(step - 1);
  }, [step, setError]);

  return {
    step,
    handleNextStep,
    handlePreviousStep,
  };
}
