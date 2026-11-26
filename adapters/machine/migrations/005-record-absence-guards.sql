-- A missing row cannot be row-locked. Shared transaction advisory locks held by
-- checkAbsent pair with this writer trigger, including direct SQL writers.
-- Hash collisions only serialize unrelated keys; they never weaken a guard.
CREATE OR REPLACE FUNCTION ubeeq_lock_record_key() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_key BIGINT; next_key BIGINT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    previous_key := hashtextextended(jsonb_build_array(OLD.repository,OLD.id)::text,0);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    next_key := hashtextextended(jsonb_build_array(NEW.repository,NEW.id)::text,0);
  END IF;
  IF previous_key IS NULL THEN
    PERFORM pg_advisory_xact_lock(next_key);
  ELSIF next_key IS NULL OR previous_key = next_key THEN
    PERFORM pg_advisory_xact_lock(previous_key);
  ELSE
    -- Direct SQL key moves acquire both keys in stable order.
    PERFORM pg_advisory_xact_lock(LEAST(previous_key,next_key));
    PERFORM pg_advisory_xact_lock(GREATEST(previous_key,next_key));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ubeeq_record_key_lock BEFORE INSERT OR UPDATE OR DELETE ON ubeeq_records
FOR EACH ROW EXECUTE FUNCTION ubeeq_lock_record_key();
