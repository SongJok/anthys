ALTER TABLE runs ADD COLUMN active_ms numeric(20,3) NOT NULL DEFAULT 0 CHECK(active_ms>=0),ADD COLUMN active_accounted_at timestamptz,ADD COLUMN active_time_state text NOT NULL DEFAULT 'KNOWN' CHECK(active_time_state IN ('KNOWN','LEGACY_UNKNOWN'));
UPDATE runs SET active_time_state='LEGACY_UNKNOWN';
CREATE FUNCTION public.oa_runtime_active_accounting() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_at timestamptz:=clock_timestamp(); elapsed numeric:=0;
BEGIN
 IF OLD.status='RUNNING' AND OLD.active_accounted_at IS NOT NULL AND OLD.lease_until IS NOT NULL THEN
  elapsed:=greatest(0,extract(epoch FROM (least(current_at,OLD.lease_until)-OLD.active_accounted_at))*1000);
 END IF;
 NEW.active_ms:=greatest(NEW.active_ms,OLD.active_ms+elapsed);
 IF NEW.status='RUNNING' AND NEW.lease_until>current_at AND NEW.lease_owner IS NOT NULL THEN NEW.active_accounted_at:=current_at;ELSE NEW.active_accounted_at:=NULL;END IF;
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION public.oa_runtime_active_accounting() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oa_runtime_active_accounting() TO oa_runtime,oa_app;
CREATE TRIGGER runtime_active_accounting BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION public.oa_runtime_active_accounting();
