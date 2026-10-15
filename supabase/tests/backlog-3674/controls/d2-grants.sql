-- Privileges after the apply (production counts per C-5 corrected, Step 0):
--   authenticated UPDATE: 16 -> 17, exactly 3714's 16 plus tour_dismissed_at
--   anon UPDATE: 0
--   SELECT / INSERT / REFERENCES for anon and authenticated: every column (39 -> 40 in prod)
DO $$ DECLARE n int; extra text; BEGIN
  PERFORM pg_temp.check('d2 authenticated UPDATE = 17 columns',
    pg_temp.priv_count('authenticated', 'UPDATE') = 17, pg_temp.priv_count('authenticated', 'UPDATE')::text);
  SELECT string_agg(a.attname::text, ',' ORDER BY a.attname) INTO extra FROM pg_attribute a
   WHERE a.attrelid = 'public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE')
     AND a.attname NOT IN ('id','email','first_name','last_name','display_name','avatar_url','last_login_at',
       'updated_at','terms_accepted_at','terms_version_accepted','privacy_policy_accepted_at',
       'privacy_policy_version_accepted','email_onboarding_completed_at','onboarding_completed_at',
       'oauth_provider','oauth_id');
  PERFORM pg_temp.check('d2 authenticated UPDATE set = 3714 list + tour_dismissed_at only',
    extra = 'tour_dismissed_at', coalesce(extra, '<none>'));
  PERFORM pg_temp.check('d2 anon UPDATE = 0 columns',
    pg_temp.priv_count('anon', 'UPDATE') = 0, pg_temp.priv_count('anon', 'UPDATE')::text);
  n := pg_temp.col_count();
  PERFORM pg_temp.check('d2 SELECT/INSERT/REFERENCES cover every column for anon and authenticated (' || n || ')',
    pg_temp.priv_count('anon', 'SELECT') = n AND pg_temp.priv_count('anon', 'INSERT') = n
    AND pg_temp.priv_count('anon', 'REFERENCES') = n AND pg_temp.priv_count('authenticated', 'SELECT') = n
    AND pg_temp.priv_count('authenticated', 'INSERT') = n AND pg_temp.priv_count('authenticated', 'REFERENCES') = n,
    format('anon %s/%s/%s auth %s/%s/%s of %s',
      pg_temp.priv_count('anon', 'SELECT'), pg_temp.priv_count('anon', 'INSERT'), pg_temp.priv_count('anon', 'REFERENCES'),
      pg_temp.priv_count('authenticated', 'SELECT'), pg_temp.priv_count('authenticated', 'INSERT'),
      pg_temp.priv_count('authenticated', 'REFERENCES'), n));
END $$;
