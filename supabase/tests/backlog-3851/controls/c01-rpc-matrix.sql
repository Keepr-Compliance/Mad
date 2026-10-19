-- c01 set_member_license: every caller x target x action in o_org (room to spare, so the
-- answer is authorization and transition only). Expected values come from the spec below,
-- not from the database: caller must hold an access-granting ('active') broker / admin /
-- it_admin row in the target's organization; reactivate needs admin / it_admin; own row
-- refused; an it_admin target needs an it_admin caller; an unclaimed invite cannot change;
-- assign unassigned->active, unassign active->unassigned, reactivate suspended/expired->active.
SELECT pg_temp.set_status('o_unc', 'unassigned');
SELECT pg_temp.set_status('o_tun', 'unassigned');
SELECT pg_temp.set_status('o_tunit', 'unassigned');

CREATE TEMP TABLE t01_caller (u text, member text, role text, status text, org text) ON COMMIT DROP;
INSERT INTO t01_caller VALUES
  ('u_oad','o_ad','admin','active','o'), ('u_obr','o_br','broker','active','o'), ('u_oit','o_it','it_admin','active','o'),
  ('u_oag','o_ag','agent','active','o'), ('u_osad','o_sad','admin','suspended','o'), ('u_ounc','o_unc','broker','unassigned','o'),
  ('u_fad','f_ad','admin','active','f');  -- admin of ANOTHER organization
CREATE TEMP TABLE t01_target (member text, u text, role text, status text) ON COMMIT DROP;
INSERT INTO t01_target VALUES
  ('o_tact','u_otact','agent','active'), ('o_tun','u_otun','agent','unassigned'), ('o_tpen',NULL,'agent','pending'),
  ('o_tsus','u_otsus','agent','suspended'), ('o_texp','u_otexp','agent','expired'), ('o_tit','u_otit','it_admin','active'),
  ('o_tbr','u_otbr','broker','active'), ('o_tunit','u_otunit','it_admin','unassigned'), ('o_ad','u_oad','admin','active');

CREATE TEMP TABLE t01_cell ON COMMIT DROP AS
SELECT c.u AS caller, t.member AS target, a.action,
  CASE
    WHEN a.action NOT IN ('assign','unassign','reactivate') THEN 'invalid_transition'
    WHEN c.org <> 'o' OR c.status <> 'active' OR c.role NOT IN ('broker','admin','it_admin') THEN 'not_authorized'
    WHEN a.action = 'reactivate' AND c.role NOT IN ('admin','it_admin') THEN 'not_authorized'
    WHEN t.u = c.u THEN 'not_authorized'
    WHEN t.role = 'it_admin' AND c.role <> 'it_admin' THEN 'not_authorized'
    WHEN t.u IS NULL THEN 'invalid_transition'
    WHEN a.action = 'assign' AND t.status = 'unassigned' THEN '<null>'
    WHEN a.action = 'unassign' AND t.status = 'active' THEN '<null>'
    WHEN a.action = 'reactivate' AND t.status IN ('suspended','expired') THEN '<null>'
    ELSE 'invalid_transition'
  END AS expected
FROM t01_caller c CROSS JOIN t01_target t CROSS JOIN (VALUES ('assign'),('unassign'),('reactivate'),('bogus')) a(action);

ALTER TABLE t01_cell ADD COLUMN actual text;
UPDATE t01_cell SET actual = pg_temp.sml(caller, target, action);

SELECT pg_temp.check('c01 cell ' || caller || ' ' || action || ' ' || target, actual = 'OK ' || expected,
                     'expected ' || expected || ' got ' || actual)
  FROM t01_cell ORDER BY caller, target, action;
SELECT pg_temp.check('c01 matrix size', (SELECT count(*) FROM t01_cell) = 7 * 9 * 4, (SELECT count(*)::text FROM t01_cell));
SELECT pg_temp.check('c01 matrix has successes of each action',
  (SELECT count(DISTINCT action) FROM t01_cell WHERE expected = '<null>') = 3, NULL);

-- Callers outside the matrix.
SELECT pg_temp.check('c01 signed-out (anon) cannot execute',
  pg_temp.as_role('anon', NULL, format('select public.set_member_license(%L::uuid, %L)', pg_temp.id('o_tact'), 'unassign')) LIKE 'ERR 42501%',
  pg_temp.as_role('anon', NULL, format('select public.set_member_license(%L::uuid, %L)', pg_temp.id('o_tact'), 'unassign')));
SELECT pg_temp.check('c01 service_role (no user) is not_authorized',
  pg_temp.as_service(format('select public.set_member_license(%L::uuid, %L) ->> ''error''', pg_temp.id('o_tact'), 'unassign')) = 'OK not_authorized',
  pg_temp.as_service(format('select public.set_member_license(%L::uuid, %L) ->> ''error''', pg_temp.id('o_tact'), 'unassign')));
SELECT pg_temp.check('c01 unknown member id is not_authorized',
  pg_temp.as_user('u_oad', format('select public.set_member_license(%L::uuid, %L) ->> ''error''', pg_temp.id('nonexistent-3851'), 'unassign')) = 'OK not_authorized', NULL);

-- Q3: reactivate in a FULL organization returns the typed seat error (portal maps it to
-- "free or assign a licence on the Users page / contact Keepr support to add seats").
SELECT pg_temp.check('c01 reactivate in a full organization -> seat_limit_reached',
  pg_temp.sml('u_fad', 'f_sus', 'reactivate') = 'OK seat_limit_reached', pg_temp.sml('u_fad', 'f_sus', 'reactivate'));
SELECT pg_temp.check('c01 refused reactivate leaves the row suspended', pg_temp.status('f_sus') = 'suspended', pg_temp.status('f_sus'));
-- And a successful one changes the row (the matrix rolls each call back).
SELECT pg_temp.check('c01 reactivate in room: row becomes active',
  (pg_temp.sml_keep('u_oad', 'o_tsus', 'reactivate') ->> 'success') = 'true' AND pg_temp.status('o_tsus') = 'active', pg_temp.status('o_tsus'));
