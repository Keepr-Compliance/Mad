-- c07 helper truth tables. Corpus: every CHECK value, NULL, an unknown value; origins incl.
-- directory_sync; invite expiry on both sides of now().
CREATE TEMP TABLE t07 (fn text, arg text, got boolean, want boolean) ON COMMIT DROP;
INSERT INTO t07
SELECT 'holds_seat', coalesce(s, '<null>'), public.member_status_holds_seat(s), w
  FROM (VALUES ('active',true),('pending',true),('suspended',false),('expired',false),('unassigned',false),(NULL,false),('bogus',false)) v(s, w)
UNION ALL
SELECT 'is_deactivated', coalesce(s, '<null>'), public.member_status_is_deactivated(s), w
  FROM (VALUES ('active',false),('pending',false),('suspended',true),('expired',true),('unassigned',false),(NULL,false),('bogus',false)) v(s, w)
UNION ALL
SELECT 'grants_access', coalesce(s, '<null>'), public.member_status_grants_access(s), w
  FROM (VALUES ('active',true),('pending',false),('suspended',false),('expired',false),('unassigned',false),(NULL,false),('bogus',false)) v(s, w)
UNION ALL
SELECT 'origin_is_idp', coalesce(s, '<null>'), public.member_origin_is_idp(s), w
  FROM (VALUES ('jit',true),('scim',true),('directory_sync',true),('manual',false),('invite',false),(NULL,false),('bogus',false)) v(s, w)
UNION ALL
SELECT 'row_holds_seat', d, public.member_row_holds_seat(s, e, u), w
  FROM (VALUES
    ('active, unclaimed, expired',        'active',     now() - interval '1 day', NULL::uuid, true),
    ('pending, unclaimed, +3 days',       'pending',    now() + interval '3 days', NULL, true),
    ('pending, unclaimed, +1 hour',       'pending',    now() + interval '1 hour', NULL, true),
    ('pending, unclaimed, -1 second',     'pending',    now() - interval '1 second', NULL, false),
    ('pending, unclaimed, -3 days',       'pending',    now() - interval '3 days', NULL, false),
    ('pending, unclaimed, no expiry',     'pending',    NULL, NULL, true),
    ('pending, claimed, -3 days',         'pending',    now() - interval '3 days', md5('x')::uuid, true),
    ('suspended',                         'suspended',  NULL, md5('x')::uuid, false),
    ('expired',                           'expired',    NULL, md5('x')::uuid, false),
    ('unassigned',                        'unassigned', NULL, md5('x')::uuid, false),
    ('NULL status',                       NULL,         NULL, md5('x')::uuid, false),
    ('bogus status',                      'bogus',      NULL, md5('x')::uuid, false)) v(d, s, e, u, w);
SELECT pg_temp.check('c07 ' || fn || '(' || arg || ')', got IS NOT DISTINCT FROM want, 'got ' || coalesce(got::text, '<null>')) FROM t07 ORDER BY fn, arg;
