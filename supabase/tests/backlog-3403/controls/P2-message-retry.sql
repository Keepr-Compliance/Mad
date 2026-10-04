-- P2: message insert retried ON CONFLICT (id) DO NOTHING: 0 rows added
SELECT pg_temp.claims(:'A'); SET LOCAL ROLE authenticated;
WITH i AS (INSERT INTO public.submission_messages (id, submission_id, channel) VALUES (:'M1', :'S', 'sms')
           ON CONFLICT (id) DO NOTHING RETURNING 1) SELECT pg_temp.ok(count(*) = 0, 'P2') FROM i;
