/**
 * A text input for a dollar amount that adds thousands separators as you type
 * (BACKLOG-3614): 100 -> 1,000 -> 1,000,000. The one price input for the app
 * (BACKLOG-3677): New Transaction's Listing Price and the Verify step's Sale
 * Price both use it. The caret is kept by digit index — it stays beside the
 * digit it was next to on insert and delete, including in the middle of the
 * number; deleting a comma deletes the digit on the far side of it. An amount
 * with no non-zero digit is blank, never 0.
 *
 * Controlled: `value` is the display text ("1,000,000") and `onValueChange`
 * receives the new display text. Parse it with `parseMoney` to get the plain
 * number that is stored.
 */

import React, { useLayoutEffect, useRef } from "react";
import {
  deleteAcrossSeparator,
  formatMoneyEdit,
  settleMoneyOnBlur,
} from "../../utils/liveMoneyFormat";

type NativeInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "defaultValue"
>;

export interface LiveMoneyInputProps extends NativeInputProps {
  value: string;
  onValueChange: (text: string) => void;
}

function LiveMoneyInput({
  value,
  onValueChange,
  onKeyDown,
  onKeyUp,
  onBlur,
  ...rest
}: LiveMoneyInputProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  // The caret position to restore once the new value has been rendered.
  const pendingCaret = useRef<number | null>(null);
  // The last deletion key pressed, so a comma-only deletion knows its direction.
  const lastDeleteKey = useRef<"Backspace" | "Delete" | null>(null);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    lastDeleteKey.current =
      e.key === "Backspace" || e.key === "Delete" ? e.key : null;
    onKeyDown?.(e);
  };

  // SR review 3008b20f: a Backspace that deletes nothing fires no change event,
  // so the key is forgotten when it is released — otherwise a later key-less
  // edit (a cut) would be treated as that Backspace.
  const handleKeyUp = (e: React.KeyboardEvent<HTMLInputElement>) => {
    lastDeleteKey.current = null;
    onKeyUp?.(e);
  };

  // A zero amount left in the field ("0.") becomes blank, and a trailing "."
  // is dropped, when the field loses focus.
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    lastDeleteKey.current = null;
    const settled = settleMoneyOnBlur(value);
    if (settled !== value) onValueChange(settled);
    onBlur?.(e);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const raw = el.value;
    const rawCaret = el.selectionStart ?? raw.length;
    const key = lastDeleteKey.current;
    lastDeleteKey.current = null;

    const result =
      (key && deleteAcrossSeparator(value, raw, rawCaret, key)) ||
      formatMoneyEdit(value, raw, rawCaret);

    if (!result || result.text === value) {
      // Nothing changed (a letter, a third decimal), or the edit was rejected
      // because it would drop characters already in the field (a "." typed
      // before existing decimals): no re-render will follow, so
      // put the text back here and the caret where it was before the edit —
      // otherwise it is left wherever the browser put it.
      const before = Math.min(
        Math.max(rawCaret - (raw.length - value.length), 0),
        value.length,
      );
      el.value = value;
      el.setSelectionRange(before, before);
      return;
    }
    pendingCaret.current = result.caret;
    onValueChange(result.text);
  };

  return (
    <input
      {...rest}
      ref={inputRef}
      type="text"
      value={value}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      onChange={handleChange}
    />
  );
}

export default LiveMoneyInput;
