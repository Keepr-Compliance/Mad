-- The mcp_settings columns setup.sql changes, and the allowlist row count, as text.
SELECT enabled::text AS enabled, coalesce(encode(portal_secret_sha256, 'hex'), '') AS secret_hex,
       (SELECT count(*) FROM public.mcp_redirect_allowlist)::text AS allow_n
  FROM public.mcp_settings WHERE id;
