/** OAuth endpoint paths on the portal origin (BACKLOG-4238). */

export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REGISTER_PATH = '/oauth/register';

/** The consent page; the request id is appended. The page itself is not part of this route set. */
export const CONSENT_PATH_PREFIX = '/dashboard/account/ai-apps/connect/';

/** Browser binding cookie set by /oauth/authorize. */
export const BINDING_COOKIE = '__Host-kpr_mcp_bind';
