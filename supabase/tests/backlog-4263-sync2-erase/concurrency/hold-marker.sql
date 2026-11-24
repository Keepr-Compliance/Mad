/*p_hold:__RUN__*/
-- /*t:sessA*/ session A only: this run's hold marker, FIRST in the call text. pg_stat_activity.query keeps only the first
-- track_activity_query_size bytes of a call (1 kB on the test project), and the gate in session 2 looks for this marker.
