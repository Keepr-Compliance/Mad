-- The mcp_settings columns setup.sql changes, as text.
SELECT enabled::text AS enabled, coalesce(encode(portal_secret_sha256, 'hex'), '') AS secret_hex FROM public.mcp_settings WHERE id;
