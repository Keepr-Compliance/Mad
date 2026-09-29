/**
 * BACKLOG-3520 — form state for the commission block of "Verify Transaction
 * Details", shared by ExportModal and SubmitForReviewModal.
 *
 * Commission Actual FOLLOWS Commission Offered — it is a copy of what was typed
 * there — until the agent edits Actual themselves; from then on the two are
 * independent. A saved transaction whose actual rate already differs from its
 * offered rate opens in the independent state, so reopening the dialog does not
 * overwrite a recorded reduction with the offered rate.
 */
import { useCallback, useMemo, useState } from "react";
import type { Transaction } from "@/types";
import {
  buildCommissionUpdate,
  formatRateInput,
  formatSaleInput,
  isCommissionComplete,
  parseCommission,
  type CommissionInputs,
  type CommissionUpdate,
  type ParsedCommission,
} from "./commission";

type CommissionSource = Pick<
  Transaction,
  | "sale_price"
  | "listing_price"
  | "commission_offered_rate"
  | "commission_actual_rate"
  | "commission_adjustment_reason"
>;

export interface CommissionForm {
  inputs: CommissionInputs;
  /** True while Actual is still a copy of Offered. */
  actualFollowsOffered: boolean;
  setSaleText: (text: string) => void;
  setOfferedText: (text: string) => void;
  setActualText: (text: string) => void;
  setReasonText: (text: string) => void;
  /** What the form means; `ok: false` carries the message to show. */
  parsed: { ok: true; value: ParsedCommission } | { ok: false; error: string };
  /** Both rates entered. False for an unparseable form too (it is not complete). */
  complete: boolean;
  /**
   * The update to add to the confirmed-dates save. `null` when the form is
   * invalid, and ALSO when there is nothing to say: an untouched form with no
   * figure in it names no commission key, so a host that never captures one
   * saves exactly the payload it saved before. Blanking a figure that WAS
   * saved is a change, so it is sent (as null) and clears the row.
   */
  update: CommissionUpdate | null;
  listingPrice: number | null;
}

export function initialCommissionInputs(transaction: CommissionSource): CommissionInputs {
  return {
    saleText: formatSaleInput(transaction.sale_price),
    offeredText: formatRateInput(transaction.commission_offered_rate),
    actualText: formatRateInput(transaction.commission_actual_rate),
    reasonText: transaction.commission_adjustment_reason ?? "",
  };
}

export function useCommissionForm(transaction: CommissionSource): CommissionForm {
  const [initial] = useState<CommissionInputs>(() => initialCommissionInputs(transaction));
  const [inputs, setInputs] = useState<CommissionInputs>(initial);
  // Independent from the start when a recorded actual rate already differs.
  const [actualEdited, setActualEdited] = useState<boolean>(
    () =>
      transaction.commission_actual_rate !== null &&
      transaction.commission_actual_rate !== undefined &&
      transaction.commission_actual_rate !== transaction.commission_offered_rate,
  );

  const setSaleText = useCallback((saleText: string) => setInputs((p) => ({ ...p, saleText })), []);
  const setReasonText = useCallback((reasonText: string) => setInputs((p) => ({ ...p, reasonText })), []);
  const setOfferedText = useCallback(
    (offeredText: string) =>
      setInputs((p) => (actualEdited ? { ...p, offeredText } : { ...p, offeredText, actualText: offeredText })),
    [actualEdited],
  );
  const setActualText = useCallback((actualText: string) => {
    setActualEdited(true);
    setInputs((p) => ({ ...p, actualText }));
  }, []);

  const parsed = useMemo(() => parseCommission(inputs), [inputs]);
  const complete = parsed.ok && isCommissionComplete(parsed.value);
  const update = useMemo(() => {
    if (!parsed.ok) return null;
    const touched =
      inputs.saleText !== initial.saleText ||
      inputs.offeredText !== initial.offeredText ||
      inputs.actualText !== initial.actualText ||
      inputs.reasonText !== initial.reasonText;
    const hasFigure = parsed.value.offered !== null || parsed.value.actual !== null;
    return touched || hasFigure ? buildCommissionUpdate(parsed.value) : null;
  }, [parsed, inputs, initial]);

  return {
    inputs,
    actualFollowsOffered: !actualEdited,
    setSaleText,
    setOfferedText,
    setActualText,
    setReasonText,
    parsed,
    complete,
    update,
    listingPrice: transaction.listing_price ?? null,
  };
}
