/**
 * A text input for a dollar amount that adds thousands separators as you type
 * (BACKLOG-3614): 100 -> 1,000 -> 1,000,000. The caret stays beside the digit
 * it was next to on insert and delete, including in the middle of the number;
 * deleting a comma deletes the digit on the far side of it.
 *
 * Controlled: `value` is the display text ("1,000,000") and `onValueChange`
 * receives the new display text. Parse it with `parseMoney` to get the plain
 * number that is stored.
 */

import React, { useLayoutEffect, useRef } from "react";
import { deleteAcrossSeparator, formatMoneyLive } from "../../utils/liveMoneyFormat";

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

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const raw = el.value;
    const rawCaret = el.selectionStart ?? raw.length;
    const key = lastDeleteKey.current;
    lastDeleteKey.current = null;

    const result =
      (key && deleteAcrossSeparator(value, raw, rawCaret, key)) ||
      formatMoneyLive(raw, rawCaret);

    if (result.text === value) {
      // Nothing changed (a letter, a second "."): no re-render will follow, so
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
      onChange={handleChange}
    />
  );
}

export default LiveMoneyInput;
