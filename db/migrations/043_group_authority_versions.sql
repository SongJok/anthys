-- Regranting the same values cannot revive a previously frozen audience.
-- Only the trusted administration role can update these authority records.
CREATE FUNCTION oa_group_authority_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.version<=OLD.version THEN NEW.version=OLD.version+1; END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER group_scope_version BEFORE UPDATE ON dws_group_scopes
 FOR EACH ROW EXECUTE FUNCTION oa_group_authority_version();
CREATE TRIGGER group_directory_version BEFORE UPDATE ON group_directory_bindings
 FOR EACH ROW EXECUTE FUNCTION oa_group_authority_version();
