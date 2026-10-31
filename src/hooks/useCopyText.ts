/**
 * Copy a string to the clipboard and show "Copied" for 1.2 s (BACKLOG-3964).
 * One helper for the Account tab and the account panel's User ID.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import logger from "@/utils/logger";

export const COPIED_MS = 1200;

export function useCopyText(logTag: string): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(
    (text: string): void => {
      void navigator.clipboard?.writeText(text).then(
        () => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        },
        (error: unknown) => logger.error(`[${logTag}] copy failed:`, error),
      );
    },
    [logTag],
  );

  return { copied, copy };
}
