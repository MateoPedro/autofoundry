-- Let VC run 20 companies at once and Creator keep 6 waiting for a grant. The pool and grant size stay
-- as they are on each database.
update funding_policy set max_proposed = 6, max_active = 20, updated_at = now();
