/**
 * SCIM 2.0 Error Response Helpers
 *
 * Builds standardized SCIM error responses per RFC 7644 Section 3.12.
 */

import { CORS_HEADERS, SCIM_CONTENT_TYPE, SCIM_ERROR_SCHEMA } from "./types.ts";

/**
 * Build a SCIM error response (RFC 7644 Section 3.12). `status` is sent as a string, as
 * the RFC defines it. `scimType` is included only when given (RFC 7644 Table 9 defines
 * its keywords for 400 and the 409 `uniqueness` case).
 */
export function scimError(
  status: number,
  detail: string,
  scimType?: string,
): Response {
  return new Response(
    JSON.stringify({
      schemas: [SCIM_ERROR_SCHEMA],
      detail,
      ...(scimType ? { scimType } : {}),
      status: String(status),
    }),
    {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": SCIM_CONTENT_TYPE },
    },
  );
}
