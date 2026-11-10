-- ============================================================
-- BACKLOG-4175 migration A: versioned sender rule sets
--
-- The desktop app reads its sender rules (block/keep lists and per-surface modes) from a
-- versioned rule set. This migration stores the versions on the server:
--   sender_rule_sets      one immutable row per version; released = served to every org,
--                         released = false = a canary served only to the org pinned to it
--   sender_rule_set_pins  org -> version (canaries only)
--   sender_rule_set_current()     the caller's rule set {version, content}; any signed-in user
--   sender_rule_set_publish()     owner only; a release that turns a signal live, or hides more
--                                 mail under a live signal, must first run as a canary
--   sender_rule_set_pin()         owner only; pin or unpin one org
--   sender_rule_set_revert_all()  owner only; every org back to the shipped (bundled) rules
--
-- Owner = report_my_access('sender-rules') = 'owner' (BACKLOG-4144): a Super Admin
-- (is_system role) whose role grants analytics.view.
--
-- Rollback of a bad release = publish the old content again as a NEW version. Rows are never
-- updated or deleted, and a pin can never point below the latest released version.
--
-- Client rule (PR4, recorded here so the server and the client agree): a valid answer from
-- sender_rule_set_current() always replaces the client's cache, because the server decides what
-- an org runs (unpinning a canary takes effect at the next fetch). "Newest version wins" applies
-- only between the bundled copy and the cache when no valid server answer is available.
-- Release migrations that change the bundled rules raw-INSERT the new content with
-- released = true, bundled = true at the version number the bundled copy carries.
--
-- Rollback script: supabase/tests/backlog-4175/rollback-4175.sql
-- Idempotent: safe to apply twice.
-- ============================================================

-- ============================================================
-- 1. Validators: PRIVATE. Mirror electron/utils/senderFilter/ruleSetSchema.ts at every level.
--    The server is at least as strict as the Zod schema (whatever the server accepts, Zod
--    accepts): local parts, the local part of an address and precedence values must also be
--    printable ASCII ('^[!-~]+$'), because Postgres lower() and \s differ from JavaScript's on
--    non-ASCII text. The parity test (ruleSetSqlParity-4175.test.ts + the keepr-test harness)
--    runs one corpus through both.
-- ============================================================

-- object with exactly these keys
CREATE OR REPLACE FUNCTION public._sender_rule_set_keys_exact(o JSONB, k TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN jsonb_typeof(o) IS DISTINCT FROM 'object' THEN false
    ELSE coalesce(
      (SELECT array_agg(x COLLATE "C" ORDER BY x COLLATE "C") FROM jsonb_object_keys(o) x)
        = (SELECT array_agg(y COLLATE "C" ORDER BY y COLLATE "C") FROM unnest(k) y),
      false)
  END
$fn$;

REVOKE EXECUTE ON FUNCTION public._sender_rule_set_keys_exact(JSONB, TEXT[]) FROM PUBLIC, anon, authenticated;

-- one JSON value of a kind: host | address | localpart | precedence | bulkkey. Never NULL.
CREATE OR REPLACE FUNCTION public._sender_rule_set_str_ok(v JSONB, kind TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN jsonb_typeof(v) IS DISTINCT FROM 'string' THEN false
    ELSE coalesce((
      SELECT CASE kind
        WHEN 'host' THEN char_length(s) <= 253 AND s ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'
        WHEN 'address' THEN char_length(s) <= 254 AND s ~ '^[!-~]+$'
                            AND s ~ '^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$' AND s = lower(s)
        WHEN 'localpart' THEN char_length(s) BETWEEN 1 AND 64 AND s ~ '^[!-~]+$'
                              AND s ~ '^[^@\s]+$' AND s = lower(s)
        WHEN 'precedence' THEN char_length(s) BETWEEN 1 AND 32 AND s ~ '^[!-~]+$' AND s = lower(s)
        WHEN 'bulkkey' THEN s IN ('list_unsubscribe', 'list_unsubscribe_post', 'precedence', 'auto_submitted')
        ELSE false
      END
      FROM (SELECT v #>> '{}' AS s) x), false)
  END
$fn$;

REVOKE EXECUTE ON FUNCTION public._sender_rule_set_str_ok(JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- an integer (JavaScript safe integer, as Zod v4 .int()) in [lo, hi]. Never NULL.
CREATE OR REPLACE FUNCTION public._sender_rule_set_int_ok(v JSONB, lo NUMERIC, hi NUMERIC)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN jsonb_typeof(v) IS DISTINCT FROM 'number' THEN false
    ELSE coalesce((
      SELECT n = trunc(n) AND abs(n) <= 9007199254740991 AND n >= lo AND n <= hi
      FROM (SELECT (v #>> '{}')::numeric AS n) x), false)
  END
$fn$;

REVOKE EXECUTE ON FUNCTION public._sender_rule_set_int_ok(JSONB, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;

-- a list: array, at most max_len items, each of the kind. NULL when valid, else the reason.
CREATE OR REPLACE FUNCTION public._sender_rule_set_list_invalid(a JSONB, max_len INTEGER, kind TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  v_bad BIGINT;
BEGIN
  IF jsonb_typeof(a) IS DISTINCT FROM 'array' THEN
    RETURN ': not a list';
  END IF;
  IF jsonb_array_length(a) > max_len THEN
    RETURN ': more than ' || max_len || ' items';
  END IF;
  SELECT min(e.i) INTO v_bad
  FROM jsonb_array_elements(a) WITH ORDINALITY AS e(v, i)
  WHERE NOT public._sender_rule_set_str_ok(e.v, kind);
  IF v_bad IS NOT NULL THEN
    RETURN '[' || (v_bad - 1) || ']: not a valid ' || kind;
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public._sender_rule_set_list_invalid(JSONB, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;

-- the whole rule set. NULL when valid, else a short reason ("suppress.hosts[3]: not a valid host").
CREATE OR REPLACE FUNCTION public._sender_rule_set_invalid(p JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  v_r TEXT;
  v_bad BIGINT;
  v_sig TEXT;
  v_surf TEXT;
  v_allowed JSONB;
BEGIN
  IF NOT public._sender_rule_set_keys_exact(p, ARRAY['schema', 'version', 'suppress', 'keep', 'freeMailDomains', 'thresholds', 'modes']) THEN
    RETURN 'root: keys';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p->'schema', 1, 1) THEN
    RETURN 'schema: must be 1';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p->'version', 1, 9007199254740991) THEN
    RETURN 'version: not a positive integer';
  END IF;

  -- suppress
  IF NOT public._sender_rule_set_keys_exact(p->'suppress', ARRAY['exactAddresses', 'hosts', 'localParts', 'bulkHeaders']) THEN
    RETURN 'suppress: keys';
  END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{suppress,exactAddresses}', 500, 'address');
  IF v_r IS NOT NULL THEN RETURN 'suppress.exactAddresses' || v_r; END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{suppress,hosts}', 2000, 'host');
  IF v_r IS NOT NULL THEN RETURN 'suppress.hosts' || v_r; END IF;
  IF jsonb_typeof(p #> '{suppress,localParts}') IS DISTINCT FROM 'array' THEN
    RETURN 'suppress.localParts: not a list';
  END IF;
  IF jsonb_array_length(p #> '{suppress,localParts}') > 50 THEN
    RETURN 'suppress.localParts: more than 50 items';
  END IF;
  SELECT min(e.i) INTO v_bad
  FROM jsonb_array_elements(p #> '{suppress,localParts}') WITH ORDINALITY AS e(v, i)
  WHERE NOT (public._sender_rule_set_keys_exact(e.v, ARRAY['value', 'match'])
             AND public._sender_rule_set_str_ok(e.v->'value', 'localpart')
             AND coalesce(e.v->'match' IN ('"exact"'::jsonb, '"prefix"'::jsonb), false));
  IF v_bad IS NOT NULL THEN
    RETURN 'suppress.localParts[' || (v_bad - 1) || ']: not a valid item';
  END IF;
  IF NOT public._sender_rule_set_keys_exact(p #> '{suppress,bulkHeaders}', ARRAY['anyKeyPresent', 'precedenceValues', 'autoSubmittedCounts']) THEN
    RETURN 'suppress.bulkHeaders: keys';
  END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{suppress,bulkHeaders,anyKeyPresent}', 4, 'bulkkey');
  IF v_r IS NOT NULL THEN RETURN 'suppress.bulkHeaders.anyKeyPresent' || v_r; END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{suppress,bulkHeaders,precedenceValues}', 10, 'precedence');
  IF v_r IS NOT NULL THEN RETURN 'suppress.bulkHeaders.precedenceValues' || v_r; END IF;
  IF jsonb_typeof(p #> '{suppress,bulkHeaders,autoSubmittedCounts}') IS DISTINCT FROM 'boolean' THEN
    RETURN 'suppress.bulkHeaders.autoSubmittedCounts: not a boolean';
  END IF;

  -- keep
  IF NOT public._sender_rule_set_keys_exact(p->'keep', ARRAY['platformHosts', 'platformAddresses']) THEN
    RETURN 'keep: keys';
  END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{keep,platformHosts}', 200, 'host');
  IF v_r IS NOT NULL THEN RETURN 'keep.platformHosts' || v_r; END IF;
  v_r := public._sender_rule_set_list_invalid(p #> '{keep,platformAddresses}', 200, 'address');
  IF v_r IS NOT NULL THEN RETURN 'keep.platformAddresses' || v_r; END IF;

  -- freeMailDomains
  v_r := public._sender_rule_set_list_invalid(p->'freeMailDomains', 500, 'host');
  IF v_r IS NOT NULL THEN RETURN 'freeMailDomains' || v_r; END IF;

  -- thresholds
  IF NOT public._sender_rule_set_keys_exact(p->'thresholds', ARRAY['minCensusLinkedEmails', 'reportSendIntervalHours', 'reportMaxRows']) THEN
    RETURN 'thresholds: keys';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p #> '{thresholds,minCensusLinkedEmails}', 0, 9007199254740991) THEN
    RETURN 'thresholds.minCensusLinkedEmails: not an integer >= 0';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p #> '{thresholds,reportSendIntervalHours}', 1, 9007199254740991) THEN
    RETURN 'thresholds.reportSendIntervalHours: not a positive integer';
  END IF;
  IF NOT public._sender_rule_set_int_ok(p #> '{thresholds,reportMaxRows}', 1, 500) THEN
    RETURN 'thresholds.reportMaxRows: not an integer 1-500';
  END IF;

  -- modes: 7 signals x 3 surfaces; gmailUpdates is measure-only
  IF NOT public._sender_rule_set_keys_exact(p->'modes', ARRAY['seedAddress', 'approvedHost', 'localPart', 'bulkHeaders', 'gmailPromotions', 'gmailSocial', 'gmailUpdates']) THEN
    RETURN 'modes: keys';
  END IF;
  FOREACH v_sig IN ARRAY ARRAY['seedAddress', 'approvedHost', 'localPart', 'bulkHeaders', 'gmailPromotions', 'gmailSocial', 'gmailUpdates'] LOOP
    IF NOT public._sender_rule_set_keys_exact(p #> ARRAY['modes', v_sig], ARRAY['learnQuestions', 'addressPass', 'detector']) THEN
      RETURN 'modes.' || v_sig || ': keys';
    END IF;
    v_allowed := CASE WHEN v_sig = 'gmailUpdates' THEN '["off", "measure"]'::jsonb ELSE '["off", "measure", "live"]'::jsonb END;
    FOREACH v_surf IN ARRAY ARRAY['learnQuestions', 'addressPass', 'detector'] LOOP
      IF NOT (jsonb_typeof(p #> ARRAY['modes', v_sig, v_surf]) = 'string'
              AND v_allowed @> jsonb_build_array(p #> ARRAY['modes', v_sig, v_surf])) THEN
        RETURN 'modes.' || v_sig || '.' || v_surf || ': not an allowed mode';
      END IF;
    END LOOP;
  END LOOP;

  RETURN NULL;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public._sender_rule_set_invalid(JSONB) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._sender_rule_set_invalid(JSONB) IS
  'BACKLOG-4175: NULL when a rule set is valid (mirrors ruleSetSchema.ts, server stricter on non-ASCII), else the reason. Private; also the CHECK on sender_rule_sets.';

-- ============================================================
-- 2. Tables: closed to every client role (RLS on, no policy, every privilege revoked)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sender_rule_sets (
  version      BIGINT PRIMARY KEY CHECK (version > 0),
  content      JSONB NOT NULL,
  released     BOOLEAN NOT NULL,               -- false = canary, served only to pinned orgs
  bundled      BOOLEAN NOT NULL DEFAULT false, -- true = equals a shipped bundled rule set (seed / release migrations)
  canary_org   UUID,                           -- the org a canary was published for; no FK on purpose
  published_by UUID,                           -- NULL for migration rows; never returned to clients
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sender_rule_sets_content_valid CHECK (public._sender_rule_set_invalid(content) IS NULL),
  CONSTRAINT sender_rule_sets_content_version CHECK (content->'version' = to_jsonb(version)),
  CONSTRAINT sender_rule_sets_released_canary CHECK (released = (canary_org IS NULL))
);

CREATE TABLE IF NOT EXISTS public.sender_rule_set_pins (
  org_id    UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  version   BIGINT NOT NULL REFERENCES public.sender_rule_sets(version) ON DELETE RESTRICT,
  pinned_by UUID,
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON public.sender_rule_sets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.sender_rule_set_pins FROM PUBLIC, anon, authenticated;
ALTER TABLE public.sender_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sender_rule_set_pins ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.sender_rule_sets IS
  'BACKLOG-4175: one immutable row per sender rule-set version. released = served to every org; false = canary for canary_org. Read through sender_rule_set_current() only.';
COMMENT ON TABLE public.sender_rule_set_pins IS
  'BACKLOG-4175: org -> canary version. Never below the latest released version; a release deletes every pin below it.';

-- ============================================================
-- 3. Catalog key for the owner gate (the admin page is BACKLOG-4186)
-- ============================================================
INSERT INTO public.reports (report_key) VALUES ('sender-rules') ON CONFLICT (report_key) DO NOTHING;

-- ============================================================
-- 4. Seed v1 = electron/utils/senderFilter/bundledRules.ts (a jest parity test compares them)
-- ============================================================
INSERT INTO public.sender_rule_sets (version, content, released, bundled)
VALUES (1,
-- SEED-BEGIN
'{
  "schema": 1,
  "version": 1,
  "suppress": {
    "exactAddresses": [
      "my-saved-home@mail.zillow.com",
      "recommendations@mail.zillow.com"
    ],
    "hosts": [],
    "localParts": [],
    "bulkHeaders": {
      "anyKeyPresent": [
        "list_unsubscribe",
        "list_unsubscribe_post"
      ],
      "precedenceValues": [
        "bulk",
        "list",
        "junk"
      ],
      "autoSubmittedCounts": false
    }
  },
  "keep": {
    "platformHosts": [
      "docusign.net",
      "docusign.com",
      "springcm.net",
      "showingtime.com",
      "showingtime.net"
    ],
    "platformAddresses": []
  },
  "freeMailDomains": [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "ymail.com",
    "rocketmail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "gmx.com",
    "gmx.net",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "fastmail.com",
    "comcast.net",
    "verizon.net",
    "att.net",
    "sbcglobal.net",
    "bellsouth.net",
    "cox.net",
    "charter.net",
    "earthlink.net"
  ],
  "thresholds": {
    "minCensusLinkedEmails": 20,
    "reportSendIntervalHours": 24,
    "reportMaxRows": 500
  },
  "modes": {
    "seedAddress": {
      "learnQuestions": "live",
      "addressPass": "live",
      "detector": "live"
    },
    "approvedHost": {
      "learnQuestions": "live",
      "addressPass": "live",
      "detector": "live"
    },
    "localPart": {
      "learnQuestions": "measure",
      "addressPass": "off",
      "detector": "measure"
    },
    "bulkHeaders": {
      "learnQuestions": "measure",
      "addressPass": "off",
      "detector": "measure"
    },
    "gmailPromotions": {
      "learnQuestions": "measure",
      "addressPass": "off",
      "detector": "measure"
    },
    "gmailSocial": {
      "learnQuestions": "measure",
      "addressPass": "off",
      "detector": "measure"
    },
    "gmailUpdates": {
      "learnQuestions": "measure",
      "addressPass": "off",
      "detector": "measure"
    }
  }
}'
-- SEED-END
::jsonb, true, true)
ON CONFLICT (version) DO NOTHING;

-- ============================================================
-- 5. Release guard: PRIVATE. The changes in p_new (vs the latest released content p_old) that
--    would hide more mail for every org at once, and that no canary newer than p_after has
--    carried. Returns a JSON list (empty = allowed):
--      {"kind":"mode","signal":s,"surface":f}      a cell turned live
--      {"kind":"add"|"remove","list":path,"item":x} a list change under a live signal
--      {"kind":"flag","list":path}                 autoSubmittedCounts false -> true
-- ============================================================
CREATE OR REPLACE FUNCTION public._sender_rule_set_release_blocks(p_new JSONB, p_old JSONB, p_after BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $fn$
DECLARE
  v_out JSONB := '[]'::jsonb;
  v_live TEXT[];
  c RECORD;
  l RECORD;
  e JSONB;
BEGIN
  -- a) cells newly live (read from the content, so a future signal is covered)
  FOR c IN
    SELECT s.key AS sig, f.key AS surf
    FROM jsonb_each(p_new->'modes') s, jsonb_each(s.value) f
    WHERE f.value = '"live"'::jsonb
      AND (p_old #> ARRAY['modes', s.key, f.key]) IS DISTINCT FROM '"live"'::jsonb
    ORDER BY 1, 2
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.sender_rule_sets k
      WHERE NOT k.released AND k.version > p_after
        AND k.content #> ARRAY['modes', c.sig, c.surf] = '"live"'::jsonb
    ) THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'mode', 'signal', c.sig, 'surface', c.surf));
    END IF;
  END LOOP;

  -- signals live on any surface in the content being published
  SELECT coalesce(array_agg(s.key), '{}') INTO v_live
  FROM jsonb_each(p_new->'modes') s
  WHERE EXISTS (SELECT 1 FROM jsonb_each(s.value) f WHERE f.value = '"live"'::jsonb);

  -- b) list changes that hide more mail under a live signal. Element-wise, never by length.
  --    sig = NULL means "any signal that a keep rule can block" (every signal but seedAddress).
  FOR l IN
    SELECT * FROM (VALUES
      ('{suppress,exactAddresses}'::text[], 'add', 'seedAddress'),
      ('{suppress,hosts}'::text[], 'add', 'approvedHost'),
      ('{suppress,localParts}'::text[], 'add', 'localPart'),
      ('{suppress,bulkHeaders,anyKeyPresent}'::text[], 'add', 'bulkHeaders'),
      ('{suppress,bulkHeaders,precedenceValues}'::text[], 'add', 'bulkHeaders'),
      ('{keep,platformHosts}'::text[], 'remove', NULL),
      ('{keep,platformAddresses}'::text[], 'remove', NULL),
      ('{freeMailDomains}'::text[], 'add', NULL)
    ) AS t(path, dir, sig)
  LOOP
    CONTINUE WHEN NOT (CASE WHEN l.sig IS NULL
                            THEN EXISTS (SELECT 1 FROM unnest(v_live) x WHERE x <> 'seedAddress')
                            ELSE l.sig = ANY (v_live) END);
    FOR e IN
      SELECT x.v
      FROM jsonb_array_elements(CASE WHEN l.dir = 'add' THEN p_new ELSE p_old END #> l.path) AS x(v)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(CASE WHEN l.dir = 'add' THEN p_old ELSE p_new END #> l.path, '[]'::jsonb)) AS y(v)
        WHERE y.v = x.v)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.sender_rule_sets k
        WHERE NOT k.released AND k.version > p_after
          AND (EXISTS (SELECT 1 FROM jsonb_array_elements(k.content #> l.path) AS z(v) WHERE z.v = e))
              = (l.dir = 'add')
      ) THEN
        v_out := v_out || jsonb_build_array(jsonb_build_object('kind', l.dir, 'list', array_to_string(l.path, '.'), 'item', e));
      END IF;
    END LOOP;
  END LOOP;

  -- c) autoSubmittedCounts false -> true under a live bulkHeaders signal
  IF 'bulkHeaders' = ANY (v_live)
     AND p_new #> '{suppress,bulkHeaders,autoSubmittedCounts}' = 'true'::jsonb
     AND (p_old #> '{suppress,bulkHeaders,autoSubmittedCounts}') IS DISTINCT FROM 'true'::jsonb
     AND NOT EXISTS (
       SELECT 1 FROM public.sender_rule_sets k
       WHERE NOT k.released AND k.version > p_after
         AND k.content #> '{suppress,bulkHeaders,autoSubmittedCounts}' = 'true'::jsonb)
  THEN
    v_out := v_out || jsonb_build_array(jsonb_build_object('kind', 'flag', 'list', 'suppress.bulkHeaders.autoSubmittedCounts'));
  END IF;

  RETURN v_out;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public._sender_rule_set_release_blocks(JSONB, JSONB, BIGINT) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 6. sender_rule_set_current(): the caller's rule set
-- ============================================================
-- Intentionally open to every signed-in user (not anon): it returns product block/keep lists and
-- modes, no user data. Takes no parameter; the org is derived from auth.uid() only (brokerage
-- first, then the earliest active membership, as supabaseService.ts) and is never returned.
-- Returns {version, content}: the org's canary pin if any, else the latest RELEASED version.
CREATE OR REPLACE FUNCTION public.sender_rule_set_current()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_org UUID;
  v_version BIGINT;
  v_content JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;

  SELECT om.organization_id INTO v_org
  FROM public.organization_members om
  JOIN public.organizations o ON o.id = om.organization_id
  WHERE om.user_id = v_uid
    AND om.license_status = 'active'
  ORDER BY (o.personal_owner_user_id IS NOT NULL), om.created_at ASC NULLS LAST, om.id
  LIMIT 1;

  SELECT s.version, s.content INTO v_version, v_content
  FROM public.sender_rule_set_pins p
  JOIN public.sender_rule_sets s ON s.version = p.version
  WHERE p.org_id = v_org;

  IF v_version IS NULL THEN
    SELECT s.version, s.content INTO v_version, v_content
    FROM public.sender_rule_sets s
    WHERE s.released
    ORDER BY s.version DESC
    LIMIT 1;
  END IF;

  IF v_version IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('version', v_version, 'content', v_content);
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.sender_rule_set_current() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sender_rule_set_current() TO authenticated;

COMMENT ON FUNCTION public.sender_rule_set_current() IS
  'BACKLOG-4175: the caller''s sender rule set {version, content} (canary pin, else latest released). Intentionally open to every signed-in user: product rules, no user data. A valid answer always replaces the client cache.';

-- ============================================================
-- 7. sender_rule_set_publish(): owner only
--    p_pin_org NULL = release (served to every org; guarded), else a canary for that org.
--    content.version is overwritten with the assigned version. Returns the new version.
-- ============================================================
CREATE OR REPLACE FUNCTION public.sender_rule_set_publish(p_content JSONB, p_pin_org UUID DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_reason TEXT;
  v_new BIGINT;
  v_rel_version BIGINT;
  v_rel_content JSONB;
  v_content JSONB;
  v_blocks JSONB;
BEGIN
  IF v_uid IS NULL OR public.report_my_access('sender-rules') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.sender_rule_sets'));

  v_reason := public._sender_rule_set_invalid(p_content);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid rule set: %', v_reason USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(max(version), 0) + 1 INTO v_new FROM public.sender_rule_sets;
  SELECT version, content INTO v_rel_version, v_rel_content
  FROM public.sender_rule_sets WHERE released ORDER BY version DESC LIMIT 1;
  v_content := jsonb_set(p_content, '{version}', to_jsonb(v_new));

  IF p_pin_org IS NULL THEN
    v_blocks := public._sender_rule_set_release_blocks(v_content, v_rel_content, coalesce(v_rel_version, 0));
    IF jsonb_array_length(v_blocks) > 0 THEN
      RAISE EXCEPTION 'Publish to one test organization first (p_pin_org): % change(s) would reach every organization untested', jsonb_array_length(v_blocks)
        USING ERRCODE = '22023', DETAIL = v_blocks::text;
    END IF;
    INSERT INTO public.sender_rule_sets (version, content, released, bundled, canary_org, published_by)
    VALUES (v_new, v_content, true, false, NULL, v_uid);
    DELETE FROM public.sender_rule_set_pins WHERE version < v_new;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_pin_org) THEN
      RAISE EXCEPTION 'Organization not found' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.sender_rule_sets (version, content, released, bundled, canary_org, published_by)
    VALUES (v_new, v_content, false, false, p_pin_org, v_uid);
    INSERT INTO public.sender_rule_set_pins (org_id, version, pinned_by)
    VALUES (p_pin_org, v_new, v_uid)
    ON CONFLICT (org_id) DO UPDATE
      SET version = EXCLUDED.version, pinned_by = EXCLUDED.pinned_by, pinned_at = now();
  END IF;

  RETURN v_new;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.sender_rule_set_publish(JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sender_rule_set_publish(JSONB, UUID) TO authenticated;

COMMENT ON FUNCTION public.sender_rule_set_publish(JSONB, UUID) IS
  'BACKLOG-4175: owner only. Publish a rule set as a new version: a canary for p_pin_org, or (NULL) a release. A release that turns a cell live or hides more mail under a live signal is refused unless a newer canary carried the change (DETAIL lists the blocked changes). A release deletes every pin below it. Rollback = publish the old content again.';

-- ============================================================
-- 8. sender_rule_set_pin(): owner only. p_version NULL unpins.
-- ============================================================
CREATE OR REPLACE FUNCTION public.sender_rule_set_pin(p_org UUID, p_version BIGINT)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR public.report_my_access('sender-rules') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.sender_rule_sets'));

  IF p_org IS NULL THEN
    RAISE EXCEPTION 'Organization required' USING ERRCODE = '22023';
  END IF;
  IF p_version IS NULL THEN
    DELETE FROM public.sender_rule_set_pins WHERE org_id = p_org;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sender_rule_sets WHERE version = p_version) THEN
    RAISE EXCEPTION 'Version not found' USING ERRCODE = '22023';
  END IF;
  IF p_version < (SELECT max(version) FROM public.sender_rule_sets WHERE released) THEN
    RAISE EXCEPTION 'Cannot pin below the latest released version; roll back by publishing the old content as a new version'
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org) THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sender_rule_set_pins (org_id, version, pinned_by)
  VALUES (p_org, p_version, v_uid)
  ON CONFLICT (org_id) DO UPDATE
    SET version = EXCLUDED.version, pinned_by = EXCLUDED.pinned_by, pinned_at = now();
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.sender_rule_set_pin(UUID, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sender_rule_set_pin(UUID, BIGINT) TO authenticated;

COMMENT ON FUNCTION public.sender_rule_set_pin(UUID, BIGINT) IS
  'BACKLOG-4175: owner only. Pin one org to a version (never below the latest released), or unpin it (NULL).';

-- ============================================================
-- 9. sender_rule_set_revert_all(): owner only
--    Every org back to the shipped rules: republish the newest bundled row's content as a new
--    released version and delete every pin. Bypasses the release guard (the content ships in the
--    app anyway). Clients pick it up at their next fetch (not instant).
-- ============================================================
CREATE OR REPLACE FUNCTION public.sender_rule_set_revert_all()
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid UUID := auth.uid();
  v_new BIGINT;
  v_bundled JSONB;
BEGIN
  IF v_uid IS NULL OR public.report_my_access('sender-rules') IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.sender_rule_sets'));

  SELECT content INTO v_bundled
  FROM public.sender_rule_sets WHERE bundled ORDER BY version DESC LIMIT 1;
  IF v_bundled IS NULL THEN
    RAISE EXCEPTION 'No bundled rule set' USING ERRCODE = 'P0002';
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_new FROM public.sender_rule_sets;

  INSERT INTO public.sender_rule_sets (version, content, released, bundled, canary_org, published_by)
  VALUES (v_new, jsonb_set(v_bundled, '{version}', to_jsonb(v_new)), true, false, NULL, v_uid);
  DELETE FROM public.sender_rule_set_pins WHERE true;

  RETURN v_new;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.sender_rule_set_revert_all() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sender_rule_set_revert_all() TO authenticated;

COMMENT ON FUNCTION public.sender_rule_set_revert_all() IS
  'BACKLOG-4175: owner only. Republish the newest bundled rule set as a new released version and delete every pin.';
