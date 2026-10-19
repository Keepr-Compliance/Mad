-- c12 R4: an organization full of unclaimed invites with no access-granting claimed member.
-- The first claimed member always gets a seat (one over max_seats); the next is unassigned.
SELECT pg_temp.check('c12 w_org full of unclaimed invites', pg_temp.seats('w_org') = 2, NULL);
CREATE TEMP TABLE t12 ON COMMIT DROP AS SELECT pg_temp.provision3851('u_w1', 't_w') AS r1;
SELECT pg_temp.check('c12 first /setup caller -> admin',
  (SELECT r1 ->> 'role' FROM t12) = 'admin', (SELECT r1::text FROM t12));
SELECT pg_temp.check('c12 ... active with license_assigned_at (over the limit by one)',
  (SELECT license_status = 'active' AND license_assigned_at IS NOT NULL FROM public.organization_members
    WHERE organization_id = pg_temp.id('w_org') AND user_id = pg_temp.id('u_w1')), NULL);
SELECT pg_temp.check('c12 seats = max_seats + 1', pg_temp.seats('w_org') = 3, pg_temp.seats('w_org')::text);
CREATE TEMP TABLE t12b ON COMMIT DROP AS SELECT pg_temp.provision3851('u_w2', 't_w') AS r2;
SELECT pg_temp.check('c12 second /setup caller -> unassigned',
  (SELECT license_status FROM public.organization_members WHERE organization_id = pg_temp.id('w_org') AND user_id = pg_temp.id('u_w2')) = 'unassigned',
  (SELECT r2::text FROM t12b));
SELECT pg_temp.check('c12 seats still max_seats + 1', pg_temp.seats('w_org') = 3, NULL);
-- A deactivated claimed member does not count as the organization's manager.
CREATE TEMP TABLE t12c ON COMMIT DROP AS SELECT pg_temp.provision3851('u_w3', 't_w2') AS r3;
SELECT pg_temp.check('c12 w2_org (only a suspended claimed member): first /setup caller active',
  (SELECT license_status FROM public.organization_members WHERE organization_id = pg_temp.id('w2_org') AND user_id = pg_temp.id('u_w3')) = 'active',
  (SELECT r3::text FROM t12c));
-- A seat-taking UPDATE gets the same rule (limit max_seats + 1 at any time): reactivating
-- the suspended admin now that an access-granting member exists is refused.
SELECT pg_temp.check('c12 reactivate in w2_org after the first member -> refused',
  pg_temp.as_pg(format('update public.organization_members set license_status = %L where id = %L', 'active', pg_temp.id('w2_s'))) = 'ERR P0001 seat_limit_reached', NULL);
