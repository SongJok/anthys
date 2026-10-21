-- Older executors do not enforce the new managed binding fields. They must
-- not see managed grants during an upgrade/rollback overlap. This restrictive
-- policy adds to (and never replaces) the original tenant/owner RLS policy.
CREATE POLICY managed_reader_admission ON public.resource_grants AS RESTRICTIVE FOR SELECT
 USING(managed_capability_version IS NULL OR current_setting('app.managed_grant_protocol',true)='OA_MANAGED_GRANT_V1');
