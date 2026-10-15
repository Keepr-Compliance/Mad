-- Control (1): an override with no paid_through, or JSON null, is not date-enforced.
-- The live support grant shape today is {"enabled":true} (step 0 §1).
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions', '{"enabled": true}');
SELECT pg_temp.check3('absent paid_through -> enabled', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK true/override');
SELECT pg_temp.set_override(pg_temp.porg('u_live'), 'unlimited_transactions', '{"enabled": true, "paid_through": null}');
SELECT pg_temp.check3('JSON null paid_through -> enabled', pg_temp.id('u_live'), pg_temp.porg('u_live'), 'unlimited_transactions', 'OK true/override');
