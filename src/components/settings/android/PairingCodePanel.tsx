/**
 * BACKLOG-3666: pair the extension with this Keepr. Keepr shows a one-time
 * code (8 characters, 5 minutes, single use); the user types it into the
 * Keepr box in Google Messages ("Pair with Keepr") or the extension's
 * options page. No login inside the extension: the code IS the proof that
 * the extension talks to this signed-in Keepr (SPAKE2, pair-protocol.js).
 *
 * Shown inline in the Sync flow's Connect step and as "Re-pair" in
 * Settings › Google Messages. The parent polls the state; once
 * `extensionPaired` turns true it stops showing this panel.
 */
import React, { useCallback, useEffect, useState } from "react";
import { rcsImportService } from "../../../services/rcsImportService";

/** "ABCDEFGH" → "ABCD-EFGH" (easier to read and type; the dash is ignored). */
export function formatPairCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

interface PairingCodePanelProps {
  /** "Pair" in the Sync flow, "Re-pair" in Settings. */
  label?: string;
}

export function PairingCodePanel({ label = "Show pairing code" }: PairingCodePanelProps) {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = useCallback(async () => {
    setBusy(true);
    setError(null);
    const r = await rcsImportService.pairCode();
    setBusy(false);
    if (r.success && r.data) setCode(r.data);
    else setError(r.error ?? "Keepr could not make a code. Try again.");
  }, []);

  // A code shown but no longer needed (closed, or paired) is dropped.
  useEffect(() => () => void rcsImportService.pairCancel?.(), []);

  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl border border-indigo-200 bg-indigo-50" data-testid="gm-pair-panel">
      <p className="text-sm text-gray-800">
        Pair the Keepr extension with this Keepr, once: it then works only with your Keepr app.
      </p>
      {code ? (
        <>
          <div className="text-2xl font-mono font-bold tracking-widest text-gray-900" data-testid="gm-pair-code">
            {formatPairCode(code.code)}
          </div>
          <p className="text-xs text-gray-700">
            In Google Messages, the Keepr box reads <b>Pair with Keepr</b>: type this code there (or on the extension&rsquo;s
            options page). It works once, for 5 minutes.
          </p>
          <button type="button" className="text-sm text-indigo-700 hover:text-indigo-900 text-left" onClick={() => void show()} disabled={busy}>
            Show a new code
          </button>
        </>
      ) : (
        <button
          type="button"
          className="self-start px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium"
          onClick={() => void show()}
          disabled={busy}
        >
          {busy ? "…" : label}
        </button>
      )}
      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
