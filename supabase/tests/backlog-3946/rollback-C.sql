-- BACKLOG-3946 rollback C (undoes 20261014152904): production grants on support_ticket_backlog_links.
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER ON TABLE public.support_ticket_backlog_links TO anon;
GRANT UPDATE, REFERENCES, TRIGGER ON TABLE public.support_ticket_backlog_links TO authenticated;
