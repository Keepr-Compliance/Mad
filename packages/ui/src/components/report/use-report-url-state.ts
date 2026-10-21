'use client';

import * as React from 'react';

/**
 * Report kit — client state mirrored into the URL (BACKLOG-3502a).
 *
 * The state lives in React; every change is written back to the query string
 * with `history.replaceState` — never `pushState` (Back would step through
 * every checkbox) and never a router navigation (with `force-dynamic` that is
 * a server round trip per change). Params the codec does not own are kept.
 * Safe to render on the server: the effect only runs in the browser.
 */
export interface UrlStateCodec<S> {
  /** Read the state from the current params (used by the caller, e.g. on the server). */
  parse: (params: URLSearchParams) => S;
  /** Write the state onto `params` (a copy of the current ones) and return it. */
  write: (params: URLSearchParams, state: S) => URLSearchParams;
}

export function useReportUrlState<S>(
  codec: UrlStateCodec<S>,
  initial: S | (() => S)
): [S, React.Dispatch<React.SetStateAction<S>>] {
  const [state, setState] = React.useState<S>(initial);
  const write = codec.write;

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = write(new URLSearchParams(window.location.search), state);
    const query = params.toString();
    window.history.replaceState(null, '', query.length > 0 ? `?${query}` : window.location.pathname);
  }, [write, state]);

  return [state, setState];
}
