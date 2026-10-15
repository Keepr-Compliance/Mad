-- BACKLOG-3674 fixtures. Runs inside the harness transaction, as postgres,
-- BEFORE the migrations (so the rows exist when the column is added).
-- Two unrelated signed-in users. Synthetic ids and addresses only.
INSERT INTO auth.users (id, email, aud, role) VALUES
 (pg_temp.id('u_a'), 'a-3674@example.test', 'authenticated', 'authenticated'),
 (pg_temp.id('u_b'), 'b-3674@example.test', 'authenticated', 'authenticated');
INSERT INTO public.users (id, email, oauth_provider, oauth_id) VALUES
 (pg_temp.id('u_a'), 'a-3674@example.test', 'google', 'a3674'),
 (pg_temp.id('u_b'), 'b-3674@example.test', 'google', 'b3674');
