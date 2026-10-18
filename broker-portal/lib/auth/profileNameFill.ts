/**
 * Names written to public.users when an invitation is accepted — BACKLOG-3851 PR-2f (R5).
 *
 * The identity provider's names fill only the fields that are BLANK in the stored
 * row; a stored name is never overwritten. So the name typed on the invitation
 * (copied by accept_invitation) and, later, an admin's edit stay as they are.
 * With directory sync (SCIM / Graph / Google) the directory still writes names
 * on every sync: that path is not this one.
 */

export interface ProfileNames {
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

const NAME_KEYS = ['display_name', 'first_name', 'last_name'] as const;

/** The names the identity provider gave at this sign-in. */
export function idpProfileNames(userMetadata: Record<string, unknown> | null | undefined): ProfileNames {
  const m = userMetadata ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    display_name: str(m.full_name) ?? str(m.name),
    first_name: str(m.given_name),
    last_name: str(m.family_name),
  };
}

/** The name fields to write: the IdP's value for each field the stored row has blank. */
export function blankNameFill(stored: ProfileNames | null | undefined, idp: ProfileNames): ProfileNames {
  const fill: ProfileNames = {};
  for (const key of NAME_KEYS) {
    const storedValue = stored?.[key];
    const idpValue = idp[key];
    if ((storedValue == null || storedValue.trim() === '') && idpValue) {
      fill[key] = idpValue;
    }
  }
  return fill;
}
