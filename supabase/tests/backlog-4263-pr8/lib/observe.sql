-- Real answers of the two tools, recorded for the portal's fixtures (after every control and mutation; ids are
-- replaced by <id:n> when the fixture file is written). The write switch is off.
DO $obs8$
DECLARE p jsonb;
BEGIN
  PERFORM pg_temp.unrate(); PERFORM pg_temp.sw(false);
  PERFORM pg_temp.rec('FX_fp_name', pg_temp.w(pg_temp.q_fp(1, name => 'pat fixture')));
  PERFORM pg_temp.rec('FX_fp_deal', pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA1')::text)));
  PERFORM pg_temp.rec('FX_fp_email', pg_temp.w(pg_temp.q_fp(1, email => 'pat.lender@example.test')));
  PERFORM pg_temp.rec('FX_fp_none', pg_temp.w(pg_temp.q_fp(1, name => 'nobody here')));
  p := pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA8')::text));
  PERFORM pg_temp.rec('FX_fp_page1', p);
  PERFORM pg_temp.rec('FX_fp_page2', pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA8')::text, cur => p -> 'result' -> 'page' ->> 'next_cursor')));
  PERFORM pg_temp.rec('FX_fp_long', pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DA9')::text)));
  PERFORM pg_temp.rec('FX_fp_err_not_found', pg_temp.w(pg_temp.q_fp(1, deal => pg_temp.id('DB1')::text)));
  PERFORM pg_temp.rec('FX_fp_err_invalid_input', pg_temp.w(pg_temp.q_fp(1, name => 'a')));
  PERFORM pg_temp.rec('FX_fp_err_not_entitled', pg_temp.w(pg_temp.q_fp(3, name => 'pat')));
  PERFORM pg_temp.unrate();
  INSERT INTO public.mcp_rate_counters (bucket, window_start, count) VALUES ('find_people_user:' || pg_temp.id('A')::text, public._mcp_window(interval '1 day'), 1000)
  ON CONFLICT (bucket, window_start) DO UPDATE SET count = 1000;
  PERFORM pg_temp.rec('FX_fp_err_day_limit', pg_temp.w(pg_temp.q_fp(1, name => 'pat')));
  PERFORM pg_temp.unrate();
  PERFORM pg_temp.rec('FX_td_open', pg_temp.w(pg_temp.q_td(1)));
  PERFORM pg_temp.rec('FX_td_range', pg_temp.w(pg_temp.q_td(1, st => 'all', dfrom => '2026-11-01', dto => '2026-12-31')));
  PERFORM pg_temp.rec('FX_td_done', pg_temp.w(pg_temp.q_td(1, st => 'done')));
  PERFORM pg_temp.rec('FX_td_none', pg_temp.w(pg_temp.q_td(1, ds => 'pending')));
  PERFORM pg_temp.rec('FX_td_undated', pg_temp.w(pg_temp.q_td(1, st => 'all', cur => 'none|' || pg_temp.small(0)::text)));
  PERFORM pg_temp.rec('FX_td_err_invalid_input', pg_temp.w(pg_temp.q_td(1, dfrom => '2026-12-05', dto => '2026-12-01')));
  PERFORM pg_temp.rec('FX_td_err_not_entitled', pg_temp.w(pg_temp.q_td(3)));
END
$obs8$;
