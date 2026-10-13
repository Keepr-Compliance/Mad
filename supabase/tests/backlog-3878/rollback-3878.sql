-- Rollback of 20261013170000_backlog_3878_licence_pause_resume.sql.
-- Removes the licences pause / resume trigger and its function. Rows it already
-- enqueued stay in billing_outbox (the drain still runs them; delete or park
-- them by hand if the handlers are being withdrawn too).
DROP TRIGGER IF EXISTS billing_pause_resume_on_licence_status ON public.licenses;
DROP FUNCTION IF EXISTS public._billing_on_licence_suspension();
