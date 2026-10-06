-- P3: message insert into a submitted submission: refused
UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = :'S';
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.submission_messages (submission_id, channel) VALUES ('5b340300-0000-4000-8000-000000000001', 'sms');  -- pii-allow-uuid: invented fixture id
  RAISE EXCEPTION 'P3 was allowed';
EXCEPTION WHEN insufficient_privilege THEN PERFORM pg_temp.ok(true, 'P3 refused'); END $$;
