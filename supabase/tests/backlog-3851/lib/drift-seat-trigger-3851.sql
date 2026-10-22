-- Venue setup for the M3 pre-check negative (run.sh rollback): a seat-trigger body that is
-- neither M1's nor M3's. M3 applied after this must stop at its pre-check.
CREATE OR REPLACE FUNCTION public._enforce_member_seat_limit()
 RETURNS trigger
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN NEW;  -- drifted
END;
$function$;
