/**
 * BACKLOG-3156 stage G — ONE owner of the Google Messages link state in
 * Settings > Messages.
 *
 * The Sources card (the Android row's Connected / Link control and its
 * "Show connection details") and the Google Messages pane (consent, photos,
 * videos, Force re-import) all read `rcsImportService.getExtensionState()`.
 * Settings wraps the Messages section in this provider so both read the same
 * state and a refresh from one (Unlink in Sources) reaches the other.
 *
 * Without a provider (a panel rendered on its own, as some suites do) the hook
 * reads the state itself, so neither component depends on being wrapped.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { rcsImportService } from "../../../services/rcsImportService";
import { browserLinkView, LINK_CHECK_MS, useLinkCheckOver, type BrowserLinkView } from "./browserLinkState";
import type { RcsExtensionState } from "../../../../electron/types/ipc/window-api-rcs-import";

/** SR: Unlink asks first, worded as the popup's Unlink (popup.js COPY.unlinkAsk). */
export const FORGET_ASK = "Unlink from Keepr? You'll need to link again to sync";

export interface GoogleMessagesLinkValue {
  state: RcsExtensionState | null;
  loading: boolean;
  linkView: BrowserLinkView;
  refresh: () => Promise<void>;
}

const GoogleMessagesLinkContext = createContext<GoogleMessagesLinkValue | null>(null);

function useOwnLinkState(enabled: boolean, linkCheckMs: number): GoogleMessagesLinkValue {
  const [state, setState] = useState<RcsExtensionState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const linkCheckOver = useLinkCheckOver(linkCheckMs);

  const refresh = useCallback(async () => {
    try {
      const r = await rcsImportService.getExtensionState();
      if (r.success && r.data) setState(r.data);
    } catch {
      // The previous state stays.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const linkView = browserLinkView(state, linkCheckOver);
  return useMemo(() => ({ state, loading, linkView, refresh }), [state, loading, linkView, refresh]);
}

export function GoogleMessagesLinkProvider({
  children,
  linkCheckMs = LINK_CHECK_MS,
}: {
  children: React.ReactNode;
  linkCheckMs?: number;
}): React.ReactElement {
  const value = useOwnLinkState(true, linkCheckMs);
  return <GoogleMessagesLinkContext.Provider value={value}>{children}</GoogleMessagesLinkContext.Provider>;
}

/** The shared link state, or (no provider) this component's own read of it. */
export function useGoogleMessagesLink(linkCheckMs: number = LINK_CHECK_MS): GoogleMessagesLinkValue {
  const shared = useContext(GoogleMessagesLinkContext);
  const own = useOwnLinkState(shared === null, linkCheckMs);
  return shared ?? own;
}
