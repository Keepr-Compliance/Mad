/**
 * Founder (2026-10-04): Settings never hosts its own copy of a flow screen.
 * Settings › Google Messages' "Link" / "Relink" (and keepr://link) open the
 * SAME Sync Android modal the dashboard opens, at its link step. The opener
 * sets this one-shot intent; the flow reads it once when it mounts.
 */
let startAtLink = false;

/** Ask the next Sync Android flow to open at the link step. */
export function requestLinkStep(): void {
  startAtLink = true;
}

/** Read (and clear) the request — called once by the flow when it mounts. */
export function consumeLinkStepRequest(): boolean {
  const asked = startAtLink;
  startAtLink = false;
  return asked;
}
